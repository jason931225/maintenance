//! Webmail application layer.
//!
//! Ports (capabilities the outer adapters implement), command/DTO types, audit
//! builders, and the orchestrating services. This crate has NO `sqlx` and NO
//! `lettre` dependency — it speaks only to the [`MailStore`], [`SmtpSender`],
//! [`CredentialCipher`], and [`MailNotifier`] ports, so the domain/application
//! logic stays testable without a database or a live SMTP server.
//!
//! # Write-only credentials
//!
//! A configured account NEVER round-trips its password. [`AccountView`] (the
//! get/read DTO) deliberately omits every secret and instead carries
//! `has_smtp_password`/`has_imap_password` booleans. On configure, a present
//! password is sealed via the [`CredentialCipher`] and only the ciphertext is
//! handed to the store; an absent (`None`) password leaves the stored secret
//! unchanged.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;

pub use crate::credential_cipher::{Aad, CipherError, CredentialCipher, SealedCredential};
use mnt_comms_domain::{MailSecurity, MessageAddress};
use mnt_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// CredentialCipher PORT
//
// The webmail credential-cipher capability is an APPLICATION-layer port: both
// the application services and the Postgres adapter depend on the abstraction,
// while the concrete envelope-AEAD implementation lives in the
// `mnt-comms-credential-cipher` crate (an outer/infra crate that depends on this
// one and implements the trait). Defining the trait + its value types here keeps
// the dependency direction clean (application does not depend on an adapter) and
// is why the orphan-rule blanket impls for `&C` / `Arc<C>` live alongside it.
// ---------------------------------------------------------------------------
pub mod credential_cipher {
    use secrecy::SecretBox;

    /// Errors from the credential cipher. Deliberately coarse and free of any
    /// secret material — an attacker learns only "it failed", never plaintext,
    /// key bytes, or which check failed in a way that aids forgery.
    #[derive(Debug, thiserror::Error)]
    pub enum CipherError {
        /// The master KEK env var is missing, not valid base64, or not 32 bytes.
        #[error("master key configuration error")]
        MasterKey,
        /// AEAD encryption failed (allocation/internal). Carries no detail.
        #[error("encryption failed")]
        Encrypt,
        /// AEAD decryption/authentication failed: wrong KEK, tampered ciphertext /
        /// nonce / wrapped DEK, or mismatched AAD (wrong org/account/field).
        #[error("decryption failed")]
        Decrypt,
        /// A persisted key_version this build cannot interpret.
        #[error("unsupported key version")]
        KeyVersion,
    }

    /// Associated data binding a ciphertext to the exact row + field it belongs
    /// to.
    ///
    /// Encoded into the AEAD AAD on both the secret-seal and the DEK-wrap, so a
    /// ciphertext lifted to a different org, account, or field fails to
    /// authenticate. The encoding is unambiguous (length-prefixed) so distinct
    /// triples can never collide.
    #[derive(Debug, Clone, Copy)]
    pub struct Aad<'a> {
        /// The owning tenant (`email_accounts.org_id`).
        pub org_id: &'a str,
        /// The owning account row (`email_accounts.id`).
        pub account_id: &'a str,
        /// The credential field, e.g. `"smtp_password"` / `"imap_password"`.
        pub field: &'a str,
    }

    impl Aad<'_> {
        /// Length-prefixed, unambiguous byte encoding of the triple.
        #[must_use]
        pub fn encode(&self) -> Vec<u8> {
            let mut out = Vec::new();
            for part in [self.org_id, self.account_id, self.field] {
                let bytes = part.as_bytes();
                // u32 length prefix keeps `("ab","c",..)` distinct from
                // `("a","bc",..)`.
                out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                out.extend_from_slice(bytes);
            }
            out
        }
    }

    /// The persisted output of [`CredentialCipher::encrypt`]. Every field is
    /// opaque ciphertext / nonce material safe to store; NONE of it reveals the
    /// plaintext.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SealedCredential {
        /// AEAD ciphertext of the secret (includes the Poly1305 tag).
        pub ciphertext: Vec<u8>,
        /// 24-byte XChaCha nonce used to seal the secret under the DEK.
        pub nonce: Vec<u8>,
        /// The DEK, itself AEAD-sealed under the KEK (includes its tag).
        pub dek_wrapped: Vec<u8>,
        /// 24-byte XChaCha nonce used to wrap the DEK under the KEK.
        pub dek_nonce: Vec<u8>,
        /// The KEK version used to wrap the DEK.
        pub key_version: i16,
    }

    /// Envelope credential cipher port. A single implementation
    /// (`EnvelopeCredentialCipher`, in `mnt-comms-credential-cipher`) backs it;
    /// the trait exists so application/adapter layers depend on the capability,
    /// not the concrete cipher.
    pub trait CredentialCipher: Send + Sync {
        /// Seal `plaintext` under a fresh per-row DEK wrapped by the master KEK,
        /// binding `aad` (org/account/field) as associated data.
        fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError>;

        /// Recover the plaintext secret from a [`SealedCredential`]. Fails (with
        /// the opaque [`CipherError::Decrypt`]) on a wrong KEK, any tampering, or
        /// an AAD that does not match the row the ciphertext was sealed for.
        fn decrypt(
            &self,
            sealed: &SealedCredential,
            aad: Aad<'_>,
        ) -> Result<SecretBox<Vec<u8>>, CipherError>;
    }

    /// Forward the port through a shared reference, so a `&C` satisfies a generic
    /// `C: CredentialCipher` bound without moving/cloning the KEK. (Defined here,
    /// where the trait is local, so there is no orphan-rule violation.)
    impl<C: CredentialCipher + ?Sized> CredentialCipher for &C {
        fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
            (**self).encrypt(plaintext, aad)
        }

        fn decrypt(
            &self,
            sealed: &SealedCredential,
            aad: Aad<'_>,
        ) -> Result<SecretBox<Vec<u8>>, CipherError> {
            (**self).decrypt(sealed, aad)
        }
    }

    /// Forward the port through an `Arc`, so the single shared cipher can satisfy
    /// a generic `C: CredentialCipher` bound directly.
    impl<C: CredentialCipher + ?Sized> CredentialCipher for std::sync::Arc<C> {
        fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
            (**self).encrypt(plaintext, aad)
        }

        fn decrypt(
            &self,
            sealed: &SealedCredential,
            aad: Aad<'_>,
        ) -> Result<SecretBox<Vec<u8>>, CipherError> {
            (**self).decrypt(sealed, aad)
        }
    }
}

// ---------------------------------------------------------------------------
// Local typed IDs
//
// `email_accounts.id` / `email_messages.id` have no kernel-core newtype; they
// are introduced by this subsystem, so we define transparent UUID newtypes here
// rather than widening the shared kernel.
// ---------------------------------------------------------------------------

macro_rules! comms_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
            Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(uuid::Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(uuid::Uuid::new_v4())
            }
            #[must_use]
            pub const fn from_uuid(value: uuid::Uuid) -> Self {
                Self(value)
            }
            #[must_use]
            pub const fn as_uuid(&self) -> &uuid::Uuid {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(uuid::Uuid::parse_str(s)?))
            }
        }
    };
}

comms_id!(
    /// A tenant's corporate webmail account (`email_accounts.id`).
    EmailAccountId
);
comms_id!(
    /// A stored message (`email_messages.id`).
    EmailMessageId
);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors surfaced by the application services. The store/cipher/transport
/// failures are deliberately collapsed into coarse, caller-safe variants — no
/// secret material, host detail, or raw transport string ever crosses this
/// boundary (the REST layer maps these to HTTP without leaking internals).
#[derive(Debug, thiserror::Error)]
pub enum MailServiceError {
    /// A domain/validation failure (bad address, empty recipients, …).
    #[error(transparent)]
    Domain(#[from] KernelError),
    /// No mailbox is configured for this tenant (configure it first).
    #[error("no mailbox is configured for this tenant")]
    NotConfigured,
    /// Credential sealing/opening failed (KEK/cipher problem). Caller-opaque.
    #[error("credential cipher error")]
    Cipher,
    /// The store failed. Carries an opaque, caller-safe message.
    #[error("mail store error")]
    Store,
    /// The outbound connection was refused by the SSRF/host guard or transport.
    /// The `code` is a stable, non-secret token (e.g. `host_not_allowed`).
    #[error("mail transport error: {code}")]
    Transport { code: &'static str },
    /// The per-org + per-user outbound rate limit was exceeded BEFORE any SMTP
    /// call was made. Maps to HTTP 429. The `code` is a stable, non-secret token
    /// naming the bucket that tripped (e.g. `send_per_minute`).
    #[error("rate limit exceeded: {code}")]
    RateLimited { code: &'static str },
}

impl MailServiceError {
    #[must_use]
    pub fn kind(&self) -> mnt_kernel_core::ErrorKind {
        use mnt_kernel_core::ErrorKind;
        match self {
            Self::Domain(err) => err.kind,
            Self::NotConfigured => ErrorKind::Validation,
            Self::Cipher | Self::Store => ErrorKind::Internal,
            // RateLimited has no kernel ErrorKind (there is no 429 kind); the REST
            // layer maps the variant to 429 directly, so this is only the coarse
            // bucket used for tracing. Treat it as a client/validation-class fault.
            Self::Transport { .. } | Self::RateLimited { .. } => ErrorKind::Validation,
        }
    }
}

// ---------------------------------------------------------------------------
// Commands & DTOs
// ---------------------------------------------------------------------------

/// Configure (create or replace) the tenant's mailbox. A password field set to
/// `None` leaves the stored secret unchanged; `Some(_)` re-seals it. The store
/// upserts on `(org_id, email_address)`.
#[derive(Debug, Clone)]
pub struct ConfigureAccountCommand {
    pub actor: UserId,
    /// The tenant this mailbox belongs to. Set by the REST layer from the
    /// request principal; bound into the cipher AAD and the audit event, and the
    /// adapter arms it as `app.current_org` for the upsert.
    pub org_id: OrgId,
    pub display_name: String,
    pub email_address: String,
    pub from_name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: MailSecurity,
    pub imap_username: String,
    /// Write-only: `Some` re-seals; `None` keeps the existing secret.
    pub imap_password: Option<SecretString>,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: MailSecurity,
    pub smtp_username: String,
    /// Write-only: `Some` re-seals; `None` keeps the existing secret.
    pub smtp_password: Option<SecretString>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// The read DTO for a configured mailbox. Carries NO secret — only the
/// `has_*_password` booleans signal whether a credential is on file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    pub id: EmailAccountId,
    pub display_name: String,
    pub email_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: MailSecurity,
    pub imap_username: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: MailSecurity,
    pub smtp_username: String,
    /// True when an SMTP password is stored (the value itself is write-only).
    pub has_smtp_password: bool,
    /// True when an IMAP password is stored (the value itself is write-only).
    pub has_imap_password: bool,
    pub status: String,
}

/// The decrypted SMTP transport config for a single send. Built inside the
/// service from the stored account + the cipher; the password lives in a
/// [`SecretString`] and never enters a log or a DTO.
#[derive(Clone)]
pub struct SmtpTransportConfig {
    pub host: String,
    pub port: u16,
    pub security: MailSecurity,
    pub username: String,
    pub password: SecretString,
    pub from_address: String,
    pub from_name: Option<String>,
}

impl std::fmt::Debug for SmtpTransportConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpTransportConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("security", &self.security)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("from_address", &self.from_address)
            .field("from_name", &self.from_name)
            .finish()
    }
}

/// What kind of outbound message this is. REPLY/FORWARD carry the in-reply-to /
/// references threading headers; NEW carries none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SendKind {
    New,
    Reply,
    Forward,
}

impl SendKind {
    /// The audit action code for this send kind.
    #[must_use]
    pub const fn audit_action(self) -> &'static str {
        match self {
            Self::New => "email.send",
            Self::Reply => "email.reply",
            Self::Forward => "email.forward",
        }
    }
}

/// An attachment to include on an outbound message. Bytes are carried inline;
/// the size cap is enforced by the service.
#[derive(Clone)]
pub struct OutboundAttachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for OutboundAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundAttachment")
            .field("filename", &self.filename)
            .field("content_type", &self.content_type)
            .field("bytes", &format_args!("<{} bytes>", self.bytes.len()))
            .finish()
    }
}

/// Compose an outbound message. The `From` is constrained to the account's own
/// address by the service; the caller cannot set an arbitrary sender.
#[derive(Debug, Clone)]
pub struct SendMessageCommand {
    pub actor: UserId,
    pub kind: SendKind,
    pub to: Vec<MessageAddress>,
    pub cc: Vec<MessageAddress>,
    pub bcc: Vec<MessageAddress>,
    pub subject: String,
    pub body_text: String,
    pub attachments: Vec<OutboundAttachment>,
    /// For REPLY/FORWARD: the `Message-ID` being replied to (`In-Reply-To`).
    pub in_reply_to: Option<String>,
    /// For REPLY/FORWARD: the accumulated `References` chain.
    pub references: Vec<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Recipient cap: a single send may not address more than this many recipients
/// (To + Cc + Bcc), an anti-abuse backstop.
pub const MAX_RECIPIENTS: usize = 50;
/// Maximum total attachment bytes per send.
pub const MAX_ATTACHMENT_TOTAL_BYTES: usize = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Outbound rate-limit caps (M1)
//
// A persisted, per-org + per-user fixed-window limiter. Each send/reply/forward
// is checked against BOTH a per-minute and a per-hour bucket BEFORE the SMTP
// call; test-connection is checked against a per-minute bucket. The counter is
// org-scoped + RLS-armed in the adapter (one org's usage never bleeds into
// another's). The caps are deliberately generous for a human operator but bound
// any automated/abusive loop and cap the test-connection probe (an SSRF/scan
// amplifier). Exceeding a bucket → `MailServiceError::RateLimited` → HTTP 429.
// ---------------------------------------------------------------------------

/// Max send/reply/forward operations per user, per ROLLING MINUTE.
pub const SEND_RATE_PER_MINUTE: i64 = 30;
/// Max send/reply/forward operations per user, per ROLLING HOUR.
pub const SEND_RATE_PER_HOUR: i64 = 300;
/// Max SMTP test-connection probes per user, per ROLLING MINUTE.
pub const TEST_RATE_PER_MINUTE: i64 = 5;

/// One window of the fixed-window limiter: a stable bucket key (with the window
/// size encoded, e.g. `mail_send:1m`), the window length in seconds, and the cap.
/// The `code` is the non-secret token surfaced on a 429.
#[derive(Debug, Clone, Copy)]
pub struct RateBucket {
    pub endpoint: &'static str,
    pub window_secs: i64,
    pub cap: i64,
    pub code: &'static str,
}

/// The two send/reply/forward windows (per-minute + per-hour).
pub const SEND_RATE_BUCKETS: [RateBucket; 2] = [
    RateBucket {
        endpoint: "mail_send:1m",
        window_secs: 60,
        cap: SEND_RATE_PER_MINUTE,
        code: "send_per_minute",
    },
    RateBucket {
        endpoint: "mail_send:1h",
        window_secs: 3600,
        cap: SEND_RATE_PER_HOUR,
        code: "send_per_hour",
    },
];

/// The single test-connection window (per-minute).
pub const TEST_RATE_BUCKETS: [RateBucket; 1] = [RateBucket {
    endpoint: "mail_test:1m",
    window_secs: 60,
    cap: TEST_RATE_PER_MINUTE,
    code: "test_per_minute",
}];

/// Floor a timestamp to the start of its fixed window. Mirrors the auth/sales
/// limiters' `floor_to_window`: align to the window grid so every caller in the
/// same window shares a row.
#[must_use]
pub fn floor_to_window(now: Timestamp, window_secs: i64) -> Timestamp {
    let window = window_secs.max(1);
    let unix = now.unix_timestamp();
    let floored = unix - unix.rem_euclid(window);
    Timestamp::from_unix_timestamp(floored).unwrap_or(now)
}

/// The result of a successful send: the persisted OUT message id + the
/// generated `Message-ID` header value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendResult {
    pub message_id: EmailMessageId,
    pub rfc_message_id: String,
}

/// The structured test-connection outcome. Never carries a secret; `error_code`
/// is a stable, non-secret token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

// ---------------------------------------------------------------------------
// Store-facing record types
// ---------------------------------------------------------------------------

/// The persisted row of a mailbox, as the store hands it back. Carries the
/// sealed credentials so the service can decrypt them for a send; it is NEVER
/// serialized to a client (only [`AccountView`] is).
#[derive(Debug, Clone)]
pub struct StoredAccount {
    pub id: EmailAccountId,
    pub org_id: OrgId,
    pub display_name: String,
    pub email_address: String,
    pub from_name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: MailSecurity,
    pub imap_username: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: MailSecurity,
    pub smtp_username: String,
    pub smtp_password: SealedCredential,
    pub imap_password: SealedCredential,
    pub status: String,
}

impl StoredAccount {
    #[must_use]
    pub fn to_view(&self) -> AccountView {
        AccountView {
            id: self.id,
            display_name: self.display_name.clone(),
            email_address: self.email_address.clone(),
            from_name: self.from_name.clone(),
            imap_host: self.imap_host.clone(),
            imap_port: self.imap_port,
            imap_security: self.imap_security,
            imap_username: self.imap_username.clone(),
            smtp_host: self.smtp_host.clone(),
            smtp_port: self.smtp_port,
            smtp_security: self.smtp_security,
            smtp_username: self.smtp_username.clone(),
            // A stored account always has both secrets (the DB columns are NOT
            // NULL); the booleans exist for the write-only contract and a future
            // partial-update path.
            has_smtp_password: true,
            has_imap_password: true,
            status: self.status.clone(),
        }
    }
}

/// The credential ciphertext bundle the store persists on an upsert.
#[derive(Debug, Clone)]
pub struct AccountUpsert {
    pub id: EmailAccountId,
    pub actor: UserId,
    pub display_name: String,
    pub email_address: String,
    pub from_name: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: MailSecurity,
    pub imap_username: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: MailSecurity,
    pub smtp_username: String,
    /// `Some` replaces the sealed SMTP secret; `None` keeps the existing one.
    pub smtp_password: Option<SealedCredential>,
    /// `Some` replaces the sealed IMAP secret; `None` keeps the existing one.
    pub imap_password: Option<SealedCredential>,
}

/// A direction=OUT message to persist after a successful send.
#[derive(Debug, Clone)]
pub struct OutboundRecord {
    pub id: EmailMessageId,
    pub account_id: EmailAccountId,
    pub rfc_message_id: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to: Vec<MessageAddress>,
    pub cc: Vec<MessageAddress>,
    pub bcc: Vec<MessageAddress>,
    pub subject: String,
    pub body_text: String,
    pub has_attachments: bool,
    pub sent_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/// A boxed, `Send` future — the object-safe async shape every port method
/// returns (the workspace defines async trait methods this way rather than
/// pulling `async-trait`).
pub type MailFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Persistence port for the webmail store. Every method is org-scoped (the
/// adapter arms `app.current_org` via `with_org_conn`/`with_audit`); a missing
/// tenant context fails closed in the adapter.
pub trait MailStore: Send + Sync {
    /// Fetch the tenant's single configured mailbox, or `None`.
    fn get_account(&self) -> MailFuture<'_, Result<Option<StoredAccount>, MailServiceError>>;

    /// Upsert the mailbox config (ciphertext only) and write a config audit row.
    fn upsert_account(
        &self,
        upsert: AccountUpsert,
        audit: AuditEvent,
    ) -> MailFuture<'_, Result<StoredAccount, MailServiceError>>;

    /// Persist a direction=OUT message (into its thread/folder) and write a send
    /// audit row, atomically.
    fn persist_outbound(
        &self,
        record: OutboundRecord,
        audit: AuditEvent,
    ) -> MailFuture<'_, Result<(), MailServiceError>>;

    /// Atomically increment (or create) the org-scoped, per-user fixed-window
    /// rate-limit counter for one bucket `(actor, endpoint, window_start)` under
    /// the armed tenant and return the NEW attempt count. The adapter arms
    /// `app.current_org` (RLS) for the UPSERT, so the counter is isolated by org.
    /// This is a coarse counter, NOT an audited mutation.
    fn increment_send_rate(
        &self,
        actor: UserId,
        endpoint: &'static str,
        window_start: Timestamp,
    ) -> MailFuture<'_, Result<i64, MailServiceError>>;
}

/// Outbound SMTP port. The adapter validates the host against the SSRF guard,
/// builds the MIME message, enforces TLS, and sends — then returns the RFC
/// `Message-ID` it stamped.
pub trait SmtpSender: Send + Sync {
    /// Authenticate to the configured SMTP server and report success/failure
    /// without sending anything (the test-connection probe).
    fn test_connection<'a>(
        &'a self,
        config: &'a SmtpTransportConfig,
    ) -> MailFuture<'a, Result<TestConnectionResult, MailServiceError>>;

    /// Build + send an outbound message; returns the stamped RFC `Message-ID`.
    fn send<'a>(
        &'a self,
        config: &'a SmtpTransportConfig,
        message: &'a SendMessageCommand,
        from_address: &'a str,
    ) -> MailFuture<'a, Result<String, MailServiceError>>;
}

/// Realtime notifier port (e.g. a `pg_notify` channel). A no-op stub satisfies
/// it when realtime is not wired; outbound persistence does not depend on it.
pub trait MailNotifier: Send + Sync {
    /// Signal that a message was posted for `account`. Best-effort; errors here
    /// must NOT fail the enclosing send.
    fn notify_posted(&self, account_id: EmailAccountId) -> MailFuture<'_, ()>;
}

// ---------------------------------------------------------------------------
// Audit builders
// ---------------------------------------------------------------------------

/// Build the account-config audit event. The snapshot records only
/// `{has_credential: true}` — NEVER the secret, host, or username — so the
/// audit log itself can never leak a credential.
pub fn account_config_audit_event(
    actor: UserId,
    account_id: EmailAccountId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new("email.account.configure")?,
        "email_account",
        account_id.to_string(),
        trace,
        occurred_at,
    )
    .with_snapshots(None, Some(serde_json::json!({ "has_credential": true }))))
}

/// Build the send/reply/forward audit event. The snapshot records recipient
/// COUNTS and the subject length only — not the recipient addresses or body.
pub fn send_audit_event(
    kind: SendKind,
    actor: UserId,
    message_id: EmailMessageId,
    recipient_count: usize,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(kind.audit_action())?,
        "email_message",
        message_id.to_string(),
        trace,
        occurred_at,
    )
    .with_snapshots(
        None,
        Some(serde_json::json!({ "recipient_count": recipient_count })),
    ))
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/// Configure / get / test a tenant's mailbox.
pub struct AccountService<S, T, C> {
    store: S,
    sender: T,
    cipher: C,
}

impl<S, T, C> AccountService<S, T, C>
where
    S: MailStore,
    T: SmtpSender,
    C: CredentialCipher,
{
    pub fn new(store: S, sender: T, cipher: C) -> Self {
        Self {
            store,
            sender,
            cipher,
        }
    }

    /// Return the write-only view of the configured mailbox, or `None`.
    pub async fn get_account(&self) -> Result<Option<AccountView>, MailServiceError> {
        Ok(self.store.get_account().await?.map(|a| a.to_view()))
    }

    /// Configure (upsert) the mailbox. The credentials are sealed here so only
    /// ciphertext ever reaches the store; the audit snapshot carries no secret.
    pub async fn configure(
        &self,
        command: ConfigureAccountCommand,
    ) -> Result<AccountView, MailServiceError> {
        validate_account_command(&command)?;

        // Re-use the existing account id when reconfiguring so the AAD (which
        // binds org+account+field) stays stable; otherwise mint a fresh one. The
        // org id comes from the command (the REST layer stamps the request
        // tenant), so the AAD bound here matches what `decrypt` later uses and
        // matches the org the adapter arms for the upsert.
        let existing = self.store.get_account().await?;
        let account_id = existing.as_ref().map_or_else(EmailAccountId::new, |a| a.id);
        let org_id_str = command.org_id.to_string();

        let smtp_password = self.seal_optional(
            command.smtp_password.as_ref(),
            &org_id_str,
            account_id,
            "smtp_password",
        )?;
        let imap_password = self.seal_optional(
            command.imap_password.as_ref(),
            &org_id_str,
            account_id,
            "imap_password",
        )?;

        // A brand-new account MUST supply both secrets (the DB columns are NOT
        // NULL); a reconfigure may omit them to keep the stored values.
        if existing.is_none() && (smtp_password.is_none() || imap_password.is_none()) {
            return Err(KernelError::validation(
                "configuring a new mailbox requires both the SMTP and IMAP password",
            )
            .into());
        }

        let audit = account_config_audit_event(
            command.actor,
            account_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(command.org_id);

        let upsert = AccountUpsert {
            id: account_id,
            actor: command.actor,
            display_name: command.display_name,
            email_address: command.email_address,
            from_name: command.from_name,
            imap_host: command.imap_host,
            imap_port: command.imap_port,
            imap_security: command.imap_security,
            imap_username: command.imap_username,
            smtp_host: command.smtp_host,
            smtp_port: command.smtp_port,
            smtp_security: command.smtp_security,
            smtp_username: command.smtp_username,
            smtp_password,
            imap_password,
        };

        let stored = self.store.upsert_account(upsert, audit).await?;
        Ok(stored.to_view())
    }

    /// Probe the configured SMTP server with the stored credentials.
    ///
    /// The test-connection probe makes an outbound network call, so it is
    /// rate-limited per-org + per-user (BEFORE the probe) exactly like a send —
    /// otherwise it could be abused as an SSRF/port-scan amplifier.
    pub async fn test_connection(
        &self,
        actor: UserId,
        now: Timestamp,
    ) -> Result<TestConnectionResult, MailServiceError> {
        let account = self
            .store
            .get_account()
            .await?
            .ok_or(MailServiceError::NotConfigured)?;
        enforce_rate_limit(&self.store, actor, now, &TEST_RATE_BUCKETS).await?;
        let config = self.decrypt_smtp(&account)?;
        self.sender.test_connection(&config).await
    }

    fn seal_optional(
        &self,
        password: Option<&SecretString>,
        org_id: &str,
        account_id: EmailAccountId,
        field: &str,
    ) -> Result<Option<SealedCredential>, MailServiceError> {
        let Some(password) = password else {
            return Ok(None);
        };
        let account_id_str = account_id.to_string();
        let aad = Aad {
            org_id,
            account_id: &account_id_str,
            field,
        };
        let sealed = self
            .cipher
            .encrypt(password.expose_secret().as_bytes(), aad)
            .map_err(|_| MailServiceError::Cipher)?;
        Ok(Some(sealed))
    }

    fn decrypt_smtp(
        &self,
        account: &StoredAccount,
    ) -> Result<SmtpTransportConfig, MailServiceError> {
        let org_id_str = account.org_id.to_string();
        let account_id_str = account.id.to_string();
        let aad = Aad {
            org_id: &org_id_str,
            account_id: &account_id_str,
            field: "smtp_password",
        };
        let secret = self
            .cipher
            .decrypt(&account.smtp_password, aad)
            .map_err(|_| MailServiceError::Cipher)?;
        let password = String::from_utf8(secret.expose_secret().clone())
            .map_err(|_| MailServiceError::Cipher)?;
        Ok(SmtpTransportConfig {
            host: account.smtp_host.clone(),
            port: account.smtp_port,
            security: account.smtp_security,
            username: account.smtp_username.clone(),
            password: SecretString::from(password),
            from_address: account.email_address.clone(),
            from_name: account.from_name.clone(),
        })
    }
}

/// Send / reply / forward a message through the tenant's SMTP and persist the
/// OUT row.
pub struct SendService<S, T, C, N> {
    store: S,
    sender: T,
    cipher: C,
    notifier: N,
}

impl<S, T, C, N> SendService<S, T, C, N>
where
    S: MailStore,
    T: SmtpSender,
    C: CredentialCipher,
    N: MailNotifier,
{
    pub fn new(store: S, sender: T, cipher: C, notifier: N) -> Self {
        Self {
            store,
            sender,
            cipher,
            notifier,
        }
    }

    pub async fn send(&self, command: SendMessageCommand) -> Result<SendResult, MailServiceError> {
        validate_send_command(&command)?;

        let account = self
            .store
            .get_account()
            .await?
            .ok_or(MailServiceError::NotConfigured)?;

        // Enforce the per-org + per-user outbound rate limit BEFORE the SMTP call,
        // so an abusive loop is bounded before it ever reaches the relay.
        enforce_rate_limit(
            &self.store,
            command.actor,
            command.occurred_at,
            &SEND_RATE_BUCKETS,
        )
        .await?;

        let config = decrypt_smtp_for(&self.cipher, &account)?;
        let from_address = account.email_address.clone();

        // Send first; only persist the OUT row if the SMTP server accepted it,
        // so we never leave an orphan "sent" row for a message that bounced at
        // submission time.
        let rfc_message_id = self.sender.send(&config, &command, &from_address).await?;

        let message_id = EmailMessageId::new();
        let record = OutboundRecord {
            id: message_id,
            account_id: account.id,
            rfc_message_id: rfc_message_id.clone(),
            in_reply_to: command.in_reply_to.clone(),
            references: command.references.clone(),
            from_address: from_address.clone(),
            from_name: account.from_name.clone(),
            to: command.to.clone(),
            cc: command.cc.clone(),
            bcc: command.bcc.clone(),
            subject: command.subject.clone(),
            body_text: command.body_text.clone(),
            has_attachments: !command.attachments.is_empty(),
            sent_at: command.occurred_at,
        };

        let recipient_count = command.to.len() + command.cc.len() + command.bcc.len();
        let audit = send_audit_event(
            command.kind,
            command.actor,
            message_id,
            recipient_count,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(account.org_id);

        self.store.persist_outbound(record, audit).await?;
        self.notifier.notify_posted(account.id).await;

        Ok(SendResult {
            message_id,
            rfc_message_id,
        })
    }
}

/// Check every supplied fixed-window bucket for `actor` BEFORE an outbound call.
///
/// Each bucket's counter is incremented for its live window; the FIRST bucket to
/// exceed its cap short-circuits with `RateLimited`. The increment is recorded
/// even on the request that trips the limit (so a burst is fully counted), which
/// is the same fail-shut behaviour the auth/sales limiters use. Because the
/// counter increments inside the consuming request, the cap holds across all app
/// instances (the deployment is multi-instance).
async fn enforce_rate_limit<S: MailStore>(
    store: &S,
    actor: UserId,
    now: Timestamp,
    buckets: &[RateBucket],
) -> Result<(), MailServiceError> {
    for bucket in buckets {
        let window_start = floor_to_window(now, bucket.window_secs);
        let attempts = store
            .increment_send_rate(actor, bucket.endpoint, window_start)
            .await?;
        if attempts > bucket.cap {
            return Err(MailServiceError::RateLimited { code: bucket.code });
        }
    }
    Ok(())
}

fn decrypt_smtp_for<C: CredentialCipher>(
    cipher: &C,
    account: &StoredAccount,
) -> Result<SmtpTransportConfig, MailServiceError> {
    let org_id_str = account.org_id.to_string();
    let account_id_str = account.id.to_string();
    let aad = Aad {
        org_id: &org_id_str,
        account_id: &account_id_str,
        field: "smtp_password",
    };
    let secret = cipher
        .decrypt(&account.smtp_password, aad)
        .map_err(|_| MailServiceError::Cipher)?;
    let password =
        String::from_utf8(secret.expose_secret().clone()).map_err(|_| MailServiceError::Cipher)?;
    Ok(SmtpTransportConfig {
        host: account.smtp_host.clone(),
        port: account.smtp_port,
        security: account.smtp_security,
        username: account.smtp_username.clone(),
        password: SecretString::from(password),
        from_address: account.email_address.clone(),
        from_name: account.from_name.clone(),
    })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_account_command(command: &ConfigureAccountCommand) -> Result<(), KernelError> {
    if command.display_name.trim().is_empty() {
        return Err(KernelError::validation("display name is required"));
    }
    validate_email(&command.email_address)?;
    validate_host(&command.imap_host, "IMAP host")?;
    validate_host(&command.smtp_host, "SMTP host")?;
    if command.imap_username.trim().is_empty() {
        return Err(KernelError::validation("IMAP username is required"));
    }
    if command.smtp_username.trim().is_empty() {
        return Err(KernelError::validation("SMTP username is required"));
    }
    validate_imap_port(command.imap_port)?;
    validate_smtp_port(command.smtp_port)?;
    Ok(())
}

fn validate_send_command(command: &SendMessageCommand) -> Result<(), KernelError> {
    let recipients = command.to.len() + command.cc.len() + command.bcc.len();
    if command.to.is_empty() {
        return Err(KernelError::validation(
            "at least one To recipient is required",
        ));
    }
    if recipients > MAX_RECIPIENTS {
        return Err(KernelError::validation(format!(
            "a single message may not exceed {MAX_RECIPIENTS} recipients"
        )));
    }
    if command.subject.len() > 1000 {
        return Err(KernelError::validation("subject is too long"));
    }
    let total: usize = command.attachments.iter().map(|a| a.bytes.len()).sum();
    if total > MAX_ATTACHMENT_TOTAL_BYTES {
        return Err(KernelError::validation("attachments exceed the size limit"));
    }
    if matches!(command.kind, SendKind::Reply | SendKind::Forward) && command.in_reply_to.is_none()
    {
        return Err(KernelError::validation(
            "a reply or forward requires the in-reply-to message id",
        ));
    }
    Ok(())
}

fn validate_email(value: &str) -> Result<(), KernelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.contains('@') || trimmed.len() > 320 {
        return Err(KernelError::validation("a valid email address is required"));
    }
    Ok(())
}

fn validate_host(value: &str, name: &str) -> Result<(), KernelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 255 {
        return Err(KernelError::validation(format!(
            "a valid {name} is required"
        )));
    }
    Ok(())
}

/// SMTP submission ports: 587 (STARTTLS submission) and 465 (implicit TLS). Port
/// 25 (the unauthenticated MTA-relay port) is deliberately NOT allowed — webmail
/// only ever performs authenticated message submission, and dropping 25 narrows
/// the SSRF surface (it is the classic port for relay/open-relay abuse). The DB
/// CHECK on `email_accounts.smtp_port` mirrors this exact set.
pub const ALLOWED_SMTP_PORTS: [u16; 2] = [587, 465];
/// IMAP ports: 993 (implicit TLS), 143 (STARTTLS).
pub const ALLOWED_IMAP_PORTS: [u16; 2] = [993, 143];

fn validate_smtp_port(port: u16) -> Result<(), KernelError> {
    if ALLOWED_SMTP_PORTS.contains(&port) {
        Ok(())
    } else {
        Err(KernelError::validation("SMTP port must be 587 or 465"))
    }
}

fn validate_imap_port(port: u16) -> Result<(), KernelError> {
    if ALLOWED_IMAP_PORTS.contains(&port) {
        Ok(())
    } else {
        Err(KernelError::validation("IMAP port must be 993 or 143"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_kind_audit_actions() {
        assert_eq!(SendKind::New.audit_action(), "email.send");
        assert_eq!(SendKind::Reply.audit_action(), "email.reply");
        assert_eq!(SendKind::Forward.audit_action(), "email.forward");
    }

    #[test]
    fn account_view_omits_password_fields() {
        // The view DTO has no `*_password` field at all — only the booleans.
        let stored = sample_stored();
        let view = stored.to_view();
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("password_ct"));
        assert!(!json.contains("\"smtp_password\""));
        assert!(!json.contains("\"imap_password\""));
        assert!(json.contains("has_smtp_password"));
        assert!(json.contains("has_imap_password"));
    }

    #[test]
    fn port_allowlists_reject_non_mail_ports() {
        assert!(validate_smtp_port(587).is_ok());
        assert!(validate_smtp_port(465).is_ok());
        // Port 25 (unauthenticated MTA relay) is no longer accepted: webmail only
        // performs authenticated submission on 587/465.
        assert!(validate_smtp_port(25).is_err());
        assert!(validate_smtp_port(8025).is_err());
        assert!(validate_smtp_port(80).is_err());
        assert!(validate_imap_port(993).is_ok());
        assert!(validate_imap_port(143).is_ok());
        assert!(validate_imap_port(110).is_err());
    }

    #[test]
    fn floor_to_window_aligns_to_grid() {
        // 1_700_000_040 is a multiple of 60 (and of 3600 → 1_699_999_200 is the
        // hour grid start), so an instant 5s into that minute floors back to it.
        let t = Timestamp::from_unix_timestamp(1_700_000_045).unwrap(); // grid + 5s
        assert_eq!(
            floor_to_window(t, 60).unix_timestamp(),
            1_700_000_040,
            "an instant 5s into a minute floors to the minute grid start"
        );
        assert_eq!(
            floor_to_window(t, 3600).unix_timestamp(),
            1_699_999_200,
            "the same instant floors to the hour grid start"
        );
        // Two instants in the SAME minute window [1_700_000_040, 1_700_000_100)
        // share a bucket; an instant in the NEXT minute does not.
        let a = Timestamp::from_unix_timestamp(1_700_000_041).unwrap();
        let b = Timestamp::from_unix_timestamp(1_700_000_099).unwrap();
        let next = Timestamp::from_unix_timestamp(1_700_000_100).unwrap();
        assert_eq!(floor_to_window(a, 60), floor_to_window(b, 60));
        assert_ne!(floor_to_window(b, 60), floor_to_window(next, 60));
    }

    #[test]
    fn rate_bucket_caps_are_sane() {
        // Sanity-bind the documented caps so an accidental edit is caught.
        assert_eq!(SEND_RATE_BUCKETS[0].cap, SEND_RATE_PER_MINUTE);
        assert_eq!(SEND_RATE_BUCKETS[0].window_secs, 60);
        assert_eq!(SEND_RATE_BUCKETS[1].cap, SEND_RATE_PER_HOUR);
        assert_eq!(SEND_RATE_BUCKETS[1].window_secs, 3600);
        assert_eq!(TEST_RATE_BUCKETS[0].cap, TEST_RATE_PER_MINUTE);
        assert_eq!(TEST_RATE_BUCKETS[0].window_secs, 60);
        // Per-hour cap must be at least the per-minute cap (else the minute bucket
        // is unreachable) — a compile-time invariant on the consts.
        const _: () = assert!(SEND_RATE_PER_HOUR >= SEND_RATE_PER_MINUTE);
    }

    #[test]
    fn reply_requires_in_reply_to() {
        let mut cmd = sample_send(SendKind::Reply);
        cmd.in_reply_to = None;
        assert!(validate_send_command(&cmd).is_err());
        cmd.in_reply_to = Some("<x@y>".to_owned());
        assert!(validate_send_command(&cmd).is_ok());
    }

    #[test]
    fn send_rejects_empty_to_and_over_cap() {
        let mut cmd = sample_send(SendKind::New);
        cmd.to.clear();
        assert!(validate_send_command(&cmd).is_err());

        let mut cmd = sample_send(SendKind::New);
        cmd.to = (0..MAX_RECIPIENTS + 1)
            .map(|i| MessageAddress::new(format!("u{i}@e.com")).unwrap())
            .collect();
        assert!(validate_send_command(&cmd).is_err());
    }

    fn sample_send(kind: SendKind) -> SendMessageCommand {
        SendMessageCommand {
            actor: UserId::new(),
            kind,
            to: vec![MessageAddress::new("a@b.com").unwrap()],
            cc: vec![],
            bcc: vec![],
            subject: "hi".to_owned(),
            body_text: "body".to_owned(),
            attachments: vec![],
            in_reply_to: Some("<m@h>".to_owned()),
            references: vec![],
            trace: TraceContext::generate(),
            occurred_at: Timestamp::now_utc(),
        }
    }

    fn sample_stored() -> StoredAccount {
        let sealed = SealedCredential {
            ciphertext: vec![1, 2, 3],
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 48],
            dek_nonce: vec![0; 24],
            key_version: 1,
        };
        StoredAccount {
            id: EmailAccountId::new(),
            org_id: OrgId::knl(),
            display_name: "KNL".to_owned(),
            email_address: "ops@knl.example".to_owned(),
            from_name: Some("KNL Ops".to_owned()),
            imap_host: "imap.example.com".to_owned(),
            imap_port: 993,
            imap_security: MailSecurity::SslTls,
            imap_username: "ops".to_owned(),
            smtp_host: "smtp.example.com".to_owned(),
            smtp_port: 587,
            smtp_security: MailSecurity::StartTls,
            smtp_username: "ops".to_owned(),
            smtp_password: sealed.clone(),
            imap_password: sealed,
            status: "ACTIVE".to_owned(),
        }
    }
}
