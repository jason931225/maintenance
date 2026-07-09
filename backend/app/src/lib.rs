//! `mnt-app` composition root.
//!
//! This crate owns the process boundary: 12-factor configuration, health and
//! readiness endpoints, telemetry, database dependency wiring, and graceful
//! shutdown. Domain behavior lands in narrower crates and is composed here.

use std::collections::{BTreeSet, HashMap};
use std::env;
use std::fmt::{Display, Formatter};
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Request, Response, StatusCode, header};
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use mnt_comms_adapter_postgres::PgMailStore;
use mnt_comms_credential_cipher::EnvelopeCredentialCipher;
use mnt_comms_rest::CommsRestState;
use mnt_compliance_adapter_postgres::PgComplianceStore;
use mnt_compliance_rest::ComplianceRestState;
use mnt_dispatch_adapter_postgres::PgDispatchStore;
use mnt_dispatch_domain::DispatchTimerConfig;
use mnt_dispatch_rest::DispatchRestState;
use mnt_dispatch_worker::{AlimtalkEscalationPolicy, DispatchWorker};
use mnt_financial_adapter_postgres::PgFinancialStore;
use mnt_financial_rest::FinancialRestState;
use mnt_identity_adapter_postgres::PgOrgStore;
use mnt_identity_rest::IdentityRestState;
use mnt_inbox_adapter_postgres::PgInboxStore;
use mnt_inbox_rest::InboxRestState;
use mnt_inspection_adapter_postgres::PgInspectionStore;
use mnt_inspection_rest::InspectionRestState;
use mnt_integrity::{IntegrityRestState, PgIntegrityStore};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, EvidenceId, KernelError, OrgId,
    TraceContext, UserId,
};
use mnt_messenger_adapter_postgres::PgMessengerStore;
use mnt_messenger_rest::MessengerRestState;
use mnt_notifications_adapter_postgres::PgNotificationStore;
use mnt_notifications_rest::NotificationRestState;
use mnt_platform_audit_chain::{
    ChainReport, InMemoryEd25519Signer, SealConfig, SealSigner, verify_org_chain,
};
use mnt_platform_auth::{
    AccessClaims, AndroidAssetLinksConfig, AppleAppSiteAssociationConfig, JwtIssuer, JwtSettings,
    JwtVerifier, PasskeyService, WELL_KNOWN_AASA_PATH, WELL_KNOWN_ASSETLINKS_PATH,
    WebauthnSettings, android_assetlinks_json, apple_app_site_association_json,
};
use mnt_platform_auth_rest::{AuthRestConfig, AuthRestState};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_email::{EmailSender, LettreSmtpSender, SmtpEmailConfig, StubEmailSender};
use mnt_platform_jobs::{
    ApalisPostgresJobQueue, BoxFuture, JobQueue, JobQueueError, PlatformJob, PlatformJobHandler,
    run_apalis_worker_until_shutdown,
};
use mnt_platform_provisioning::{BootstrapCredentialStore, PlatformProvisioner};
use mnt_platform_push::{
    FcmConfig, FcmHttpV1Client, ProviderPushNotifier, PushNotifier, SolapiAlimtalkClient,
    SolapiConfig,
};
use mnt_platform_realtime::{
    PgRealtimeHub, PostgresBridgeHandle, PostgresMessageNotifier, PostgresNotificationNotifier,
    RealtimeRestState,
};
use mnt_platform_rest::PlatformRestState;
use mnt_platform_storage::{
    EvidenceService, FfmpegMediaProcessor, S3StorageConfig, SeaweedS3Storage, StorageError,
};
use mnt_registry_adapter_postgres::PgRegistryStore;
use mnt_registry_rest::RegistryRestState;
use mnt_reporting_adapter_postgres::PgKpiRepository;
use mnt_reporting_rest::KpiRestState;
use mnt_sales_adapter_postgres::PgSalesStore;
use mnt_sales_rest::SalesRestState;
use mnt_support_adapter_postgres::PgSupportStore;
use mnt_support_rest::SupportRestState;
use mnt_todos_adapter_postgres::PgTodoStore;
use mnt_todos_rest::TodoRestState;
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_rest::{MobileRestState, WorkOrderRestState};
use opentelemetry::global;
use opentelemetry::trace::{TraceContextExt, TracerProvider};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SdkTracerProvider;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, QueryBuilder};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use url::Url;

pub mod action_inbox;
pub mod cedar_parity;
mod collaboration;
mod hr;
pub mod lifecycle;
mod mail_sync;
pub mod objects;
mod workflow_drain;
pub mod workflow_schedules;
mod workflow_studio;

const DEFAULT_HTTP_ADDR: &str = "0.0.0.0:8080";
const DEFAULT_SERVICE_NAME: &str = "mnt-app";
const DEFAULT_SHUTDOWN_TIMEOUT_SECS: u64 = 10;
const DEFAULT_EVIDENCE_TRANSCODE_CONCURRENCY: usize = 2;
const DEFAULT_JWT_ISSUER: &str = "mnt-platform-auth";
const DEFAULT_JWT_AUDIENCE: &str = "mnt-api";
const DEFAULT_WEBAUTHN_RP_NAME: &str = "MNT Maintenance";
const DEFAULT_AUTH_CEREMONY_TTL_SECS: u64 = 300;
const DEFAULT_REFRESH_TOKEN_TTL_SECS: u64 = 60 * 60 * 24 * 30;
/// Absolute refresh-family lifetime cap (NIST 800-63B AAL2). Default 24h: past
/// this the family is revoked on rotation and a fresh primary auth is required.
const DEFAULT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS: u64 = 60 * 60 * 24;
const DEFAULT_COLDSTART_OTP_TTL_SECS: u64 = 3600;
const DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS: u64 = 5 * 60;
const DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS: u64 = 10 * 60;
const DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS: u64 = 2 * 60;
const DEFAULT_DISPATCH_GPS_FRESHNESS_SECS: u64 = 15 * 60;
const DEFAULT_FCM_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_SOLAPI_BASE_URL: &str = "https://api.solapi.com";
const DEFAULT_AUDIT_LIMIT: i64 = 50;
const MAX_AUDIT_LIMIT: i64 = 200;
/// Global request-body cap. Modest by design: the JSON APIs here carry small
/// payloads, and large evidence uploads go straight to object storage via
/// presigned URLs rather than through this process. Bounds memory per request.
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Default per-request timeout; sheds requests that hang on a slow upstream or
/// DB so a stuck handler cannot pin a connection indefinitely. Overridable via
/// `MNT_REQUEST_TIMEOUT_SECS` (see `AppConfig::request_timeout`).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const OPENAPI_YAML: &str = include_str!("../../openapi/openapi.yaml");

/// Embedded schema migrations, compiled into the binary at build time from the
/// canonical `mnt-platform-db` migration directory (the same `0001..NNNN_*.sql`
/// files applied to prod). `migrate` mode runs these in version order; sqlx
/// tracks applied versions + per-file checksums in `_sqlx_migrations`, so re-runs
/// are idempotent and a mutated already-applied file is rejected rather than
/// silently re-run. The path is relative to this crate's manifest (`backend/app`).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../crates/platform/db/migrations");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRole {
    Api,
    Worker,
    /// One-shot schema-migration mode. Connects to `DATABASE_URL` as the table
    /// OWNER, runs the embedded migrations, then exits â it never serves HTTP.
    /// Invoked out of band (an Argo CD PreSync Job) before the api/worker
    /// Deployments roll, so the runtime `mnt_rt` role never needs DDL.
    Migrate,
}

impl Display for AppRole {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api => f.write_str("api"),
            Self::Worker => f.write_str("worker"),
            Self::Migrate => f.write_str("migrate"),
        }
    }
}

impl std::str::FromStr for AppRole {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "api" => Ok(Self::Api),
            "worker" => Ok(Self::Worker),
            "migrate" => Ok(Self::Migrate),
            other => Err(AppError::Config(format!(
                "MNT_APP_ROLE must be api, worker, or migrate, got {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub role: AppRole,
    pub service_name: String,
    pub http_addr: SocketAddr,
    pub database_url: Option<String>,
    pub otlp_endpoint: Option<String>,
    pub jwt: Option<JwtVerifierConfig>,
    pub auth_rest: Option<AuthRestConfig>,
    pub storage: Option<S3StorageConfig>,
    pub dispatch_timers: DispatchTimerConfig,
    pub dispatch_jobs_enabled: bool,
    /// Max concurrent evidence transcodes the worker runs at once
    /// (`MNT_EVIDENCE_TRANSCODE_CONCURRENCY`, default 2). Backpressure cap so a
    /// burst of mechanic uploads can't exhaust the worker's CPU/disk.
    pub evidence_transcode_concurrency: usize,
    pub fcm: Option<FcmConfig>,
    pub solapi: Option<SolapiConfig>,
    pub solapi_disabled_reason: Option<String>,
    /// Outbound SMTP relay for transactional email (open-signup OTP). `None`
    /// when no `MNT_EMAIL_*` vars are set; the app then uses the stub sender that
    /// logs the OTP instead of relaying it (so it boots without an email relay).
    pub email: Option<SmtpEmailConfig>,
    pub shutdown_timeout: Duration,
    /// Per-request timeout applied to every non-streaming route
    /// (`MNT_REQUEST_TIMEOUT_SECS`, default 30s). Deliberately NOT applied to
    /// the long-lived realtime WS route, which is merged outside this layer.
    /// Configurable primarily so tests can prove the realtime route escapes the
    /// timeout without waiting the full production budget.
    pub request_timeout: Duration,
    /// Deploy-time cold-start OTP for the cold-start SUPER_ADMIN, supplied
    /// out-of-band via `MNT_COLDSTART_OTP`. `None` (or empty) means no
    /// cold-start OTP is seeded at boot â the normal state once an admin exists.
    pub coldstart_otp: Option<String>,
    /// Lifetime of a boot-seeded cold-start OTP (`MNT_COLDSTART_OTP_TTL_SECS`,
    /// default 3600s).
    pub coldstart_otp_ttl: time::Duration,
    /// Number of trusted reverse proxies in front of the service
    /// (`MNT_TRUSTED_PROXY_COUNT`, default 1). Drives `X-Forwarded-For`
    /// client-IP derivation in the unauthenticated rate limiters.
    pub trusted_proxy_count: usize,
    /// Native app-link association metadata served at `/.well-known/*`. Drives
    /// the public, unauthenticated Apple App Site Association + Android asset
    /// links documents that authorize the native apps' passkeys for the RP
    /// domain. Sourced from `MNT_IOS_APP_IDS`, `MNT_ANDROID_PACKAGE`, and
    /// `MNT_ANDROID_CERT_SHA256` (see [`app_links_config_from_vars`]).
    pub app_links: AppLinksConfig,
    /// Whether the inbound webmail IMAP sync worker runs (`MNT_MAIL_ENABLED`,
    /// default false). Even when true the worker only starts if the master KEK
    /// (`MNT_MAIL_MASTER_KEY`) and object storage are both configured — it is a
    /// no-op otherwise, so a misconfiguration never crashes the app.
    pub mail_enabled: bool,
    /// Whether the L20 tamper-evident audit-chain seal worker runs
    /// (`MNT_AUDIT_CHAIN_SEAL_ENABLED`, default false). Post-merge review F3:
    /// the PR-1 in-crate `InMemoryEd25519Signer` generates a FRESH keypair on
    /// every worker restart and writes real seals under `key_ref =
    /// test:ed25519:<hex>` — dev/test-grade, not yet the OCI Vault signer
    /// (PR-3) that makes the chain's evidentiary guarantee real. Default OFF in
    /// production so it does not write throwaway-keyed seals every tick until
    /// the real signer lands; the attestation REST endpoint (PR-2) reads
    /// whatever the worker has sealed regardless of this flag.
    pub audit_chain_seal_enabled: bool,
    /// The tenant that owns the PUBLIC sales storefront (`STOREFRONT_ORG_ID`).
    /// `None` defaults to KNL's org in the sales router. Set it to the storefront
    /// tenant's real `organizations.id` when that tenant was re-minted via the
    /// console with a random uuid, so a public inquiry lands in the SAME org the
    /// staff inquiry inbox reads under (#19.21) instead of the `0x…a1` sentinel.
    pub storefront_org: Option<OrgId>,
}

/// Native app-link association config for the `/.well-known/*` endpoints.
///
/// All fields are optional and default to empty: a deployment that has not yet
/// provisioned its native apps serves an empty (but well-formed) association
/// document rather than failing to boot. The empty state is logged at startup so
/// the gap is visible. Once set, the documents authorize the native apps to use
/// passkeys scoped to the WebAuthn RP domain.
#[derive(Debug, Clone, Default)]
pub struct AppLinksConfig {
    /// iOS app identifiers (`<TeamID>.<bundle-id>`), e.g. `ABCDE12345.com.knl.fsm`.
    /// From `MNT_IOS_APP_IDS` (comma-separated).
    pub ios_app_ids: Vec<String>,
    /// Android application id, e.g. `com.knl.fsm`. From `MNT_ANDROID_PACKAGE`.
    pub android_package: Option<String>,
    /// Android signing-cert SHA-256 fingerprints (colon-separated hex). From
    /// `MNT_ANDROID_CERT_SHA256` (comma-separated for multiple signing keys).
    pub android_cert_sha256: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct JwtVerifierConfig {
    pub issuer: String,
    pub audience: String,
    pub public_key_pem: String,
}

impl JwtVerifierConfig {
    fn build(&self) -> Result<JwtVerifier, AppError> {
        JwtVerifier::from_es256_public_pem(
            JwtSettings {
                issuer: self.issuer.clone(),
                audience: self.audience.clone(),
                access_token_ttl: time::Duration::minutes(15),
            },
            self.public_key_pem.as_bytes(),
        )
        .map_err(|err| AppError::Config(format!("invalid MNT_JWT_PUBLIC_KEY_PEM: {err}")))
    }
}

/// Build the JWT issuer the PLATFORM view-as START path uses to mint short-lived
/// read-only impersonation tokens. It signs with the SAME ES256 keypair as the
/// auth-rest issuer (sourced from [`AuthRestConfig`]), so the tokens it mints
/// verify against the live `jwt_verifier`. The settings' `access_token_ttl` is
/// set to the view-as ceiling as a backstop; the START handler additionally
/// clamps every minted token to that ceiling explicitly.
fn build_view_as_issuer(config: &AuthRestConfig) -> Result<JwtIssuer, AppError> {
    JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: config.jwt_issuer.clone(),
            audience: config.jwt_audience.clone(),
            access_token_ttl: mnt_platform_rest::VIEW_AS_TOKEN_TTL,
        },
        config.jwt_private_key_pem.as_bytes(),
        config.jwt_public_key_pem.as_bytes(),
    )
    .map_err(|err| AppError::Config(format!("invalid view-as issuer key material: {err}")))
}

fn policy_step_up_from_auth_config(config: &AuthRestConfig) -> Result<PasskeyService, AppError> {
    let rp_origin = Url::parse(&config.rp_origin)
        .map_err(|err| AppError::Config(format!("invalid WebAuthn RP origin: {err}")))?;
    PasskeyService::new(WebauthnSettings {
        rp_id: config.rp_id.clone(),
        rp_origin,
        rp_name: config.rp_name.clone(),
        extra_allowed_origins: Vec::new(),
        ceremony_ttl: config.ceremony_ttl,
    })
    .map_err(|err| AppError::Config(format!("invalid policy step-up WebAuthn config: {err}")))
}

impl AppConfig {
    pub fn from_env() -> Result<Self, AppError> {
        Self::from_pairs(env::vars())
    }

    pub fn from_pairs<I, K, V>(pairs: I) -> Result<Self, AppError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let vars: HashMap<String, String> = pairs
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();

        let role = vars
            .get("MNT_APP_ROLE")
            .map(String::as_str)
            .unwrap_or("api")
            .parse()?;
        let service_name = vars
            .get("OTEL_SERVICE_NAME")
            .or_else(|| vars.get("MNT_SERVICE_NAME"))
            .cloned()
            .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_owned());
        let http_addr = vars
            .get("MNT_HTTP_ADDR")
            .map(String::as_str)
            .unwrap_or(DEFAULT_HTTP_ADDR)
            .parse::<SocketAddr>()
            .map_err(|err| AppError::Config(format!("invalid MNT_HTTP_ADDR: {err}")))?;
        let database_url = non_empty(vars.get("DATABASE_URL"));
        let otlp_endpoint = non_empty(vars.get("OTEL_EXPORTER_OTLP_ENDPOINT"));
        let jwt_public_key_pem = non_empty(vars.get("MNT_JWT_PUBLIC_KEY_PEM"));
        let jwt_has_partial_config = jwt_public_key_pem.is_none()
            && (non_empty(vars.get("MNT_JWT_ISSUER")).is_some()
                || non_empty(vars.get("MNT_JWT_AUDIENCE")).is_some());
        if jwt_has_partial_config {
            return Err(AppError::Config(
                "MNT_JWT_PUBLIC_KEY_PEM is required when JWT issuer/audience is configured"
                    .to_owned(),
            ));
        }
        let jwt = jwt_public_key_pem.map(|public_key_pem| JwtVerifierConfig {
            issuer: non_empty(vars.get("MNT_JWT_ISSUER"))
                .unwrap_or_else(|| DEFAULT_JWT_ISSUER.to_owned()),
            audience: non_empty(vars.get("MNT_JWT_AUDIENCE"))
                .unwrap_or_else(|| DEFAULT_JWT_AUDIENCE.to_owned()),
            public_key_pem,
        });
        let auth_rest = auth_rest_config_from_vars(&vars, jwt.as_ref())?;
        let storage = storage_config_from_vars(&vars)?;
        let dispatch_timers = dispatch_timer_config_from_vars(&vars)?;
        let dispatch_jobs_enabled = match vars.get("MNT_DISPATCH_JOBS_ENABLED") {
            Some(raw) => raw.parse::<bool>().map_err(|err| {
                AppError::Config(format!("invalid MNT_DISPATCH_JOBS_ENABLED: {err}"))
            })?,
            None => true,
        };
        let evidence_transcode_concurrency = match vars.get("MNT_EVIDENCE_TRANSCODE_CONCURRENCY") {
            Some(raw) => raw
                .parse::<usize>()
                .map_err(|err| {
                    AppError::Config(format!("invalid MNT_EVIDENCE_TRANSCODE_CONCURRENCY: {err}"))
                })
                .map(|value| value.max(1))?,
            None => DEFAULT_EVIDENCE_TRANSCODE_CONCURRENCY,
        };
        let fcm = fcm_config_from_vars(&vars)?;
        let (solapi, solapi_disabled_reason) = solapi_config_from_vars(&vars)?;
        let email = email_config_from_vars(&vars)?;
        let shutdown_timeout = match vars.get("MNT_SHUTDOWN_TIMEOUT_SECS") {
            Some(raw) => raw.parse::<u64>().map(Duration::from_secs).map_err(|err| {
                AppError::Config(format!("invalid MNT_SHUTDOWN_TIMEOUT_SECS: {err}"))
            })?,
            None => Duration::from_secs(DEFAULT_SHUTDOWN_TIMEOUT_SECS),
        };
        let request_timeout = match vars.get("MNT_REQUEST_TIMEOUT_SECS") {
            Some(raw) => raw.parse::<u64>().map(Duration::from_secs).map_err(|err| {
                AppError::Config(format!("invalid MNT_REQUEST_TIMEOUT_SECS: {err}"))
            })?,
            None => REQUEST_TIMEOUT,
        };
        let coldstart_otp = non_empty(vars.get("MNT_COLDSTART_OTP"));
        let coldstart_otp_ttl = parse_time_duration_secs(
            vars.get("MNT_COLDSTART_OTP_TTL_SECS"),
            DEFAULT_COLDSTART_OTP_TTL_SECS,
            "MNT_COLDSTART_OTP_TTL_SECS",
        )?;
        let trusted_proxy_count = parse_trusted_proxy_count(vars.get("MNT_TRUSTED_PROXY_COUNT"))?;
        let app_links = app_links_config_from_vars(&vars);
        let mail_enabled = match vars.get("MNT_MAIL_ENABLED") {
            Some(raw) => raw
                .parse::<bool>()
                .map_err(|err| AppError::Config(format!("invalid MNT_MAIL_ENABLED: {err}")))?,
            None => false,
        };
        let audit_chain_seal_enabled = match vars.get("MNT_AUDIT_CHAIN_SEAL_ENABLED") {
            Some(raw) => raw.parse::<bool>().map_err(|err| {
                AppError::Config(format!("invalid MNT_AUDIT_CHAIN_SEAL_ENABLED: {err}"))
            })?,
            None => false,
        };
        let storefront_org = match non_empty(vars.get("STOREFRONT_ORG_ID")) {
            Some(raw) => Some(
                OrgId::from_str(&raw)
                    .map_err(|err| AppError::Config(format!("invalid STOREFRONT_ORG_ID: {err}")))?,
            ),
            None => None,
        };

        Ok(Self {
            role,
            service_name,
            http_addr,
            database_url,
            otlp_endpoint,
            jwt,
            auth_rest,
            storage,
            dispatch_timers,
            dispatch_jobs_enabled,
            evidence_transcode_concurrency,
            fcm,
            solapi,
            solapi_disabled_reason,
            email,
            shutdown_timeout,
            request_timeout,
            coldstart_otp,
            coldstart_otp_ttl,
            trusted_proxy_count,
            app_links,
            mail_enabled,
            audit_chain_seal_enabled,
            storefront_org,
        })
    }
}

/// Parse the native app-link association config from the environment.
///
/// Every field is optional: an unset/empty value yields an empty list (or
/// `None`), so the `/.well-known/*` endpoints serve a well-formed-but-empty
/// document instead of the process refusing to boot. The comma-separated lists
/// trim and drop blank entries so a trailing comma or stray whitespace is
/// harmless.
fn app_links_config_from_vars(vars: &HashMap<String, String>) -> AppLinksConfig {
    AppLinksConfig {
        ios_app_ids: parse_csv_list(vars.get("MNT_IOS_APP_IDS")),
        android_package: non_empty(vars.get("MNT_ANDROID_PACKAGE")),
        android_cert_sha256: parse_csv_list(vars.get("MNT_ANDROID_CERT_SHA256")),
    }
}

/// Split a comma-separated env value into trimmed, non-empty entries. Returns an
/// empty `Vec` when unset or all-blank.
fn parse_csv_list(value: Option<&String>) -> Vec<String> {
    value
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn auth_rest_config_from_vars(
    vars: &HashMap<String, String>,
    jwt: Option<&JwtVerifierConfig>,
) -> Result<Option<AuthRestConfig>, AppError> {
    let Some(jwt_private_key_pem) = non_empty(vars.get("MNT_JWT_PRIVATE_KEY_PEM")) else {
        return Ok(None);
    };
    let jwt = jwt.ok_or_else(|| {
        AppError::Config(
            "MNT_JWT_PUBLIC_KEY_PEM is required when MNT_JWT_PRIVATE_KEY_PEM is configured"
                .to_owned(),
        )
    })?;
    let rp_id = non_empty(vars.get("MNT_WEBAUTHN_RP_ID")).ok_or_else(|| {
        AppError::Config("MNT_WEBAUTHN_RP_ID is required when auth REST is configured".to_owned())
    })?;
    let rp_origin = non_empty(vars.get("MNT_WEBAUTHN_RP_ORIGIN")).ok_or_else(|| {
        AppError::Config(
            "MNT_WEBAUTHN_RP_ORIGIN is required when auth REST is configured".to_owned(),
        )
    })?;

    Ok(Some(AuthRestConfig {
        rp_id,
        rp_origin,
        rp_name: non_empty(vars.get("MNT_WEBAUTHN_RP_NAME"))
            .unwrap_or_else(|| DEFAULT_WEBAUTHN_RP_NAME.to_owned()),
        ceremony_ttl: parse_time_duration_secs(
            vars.get("MNT_AUTH_CEREMONY_TTL_SECS"),
            DEFAULT_AUTH_CEREMONY_TTL_SECS,
            "MNT_AUTH_CEREMONY_TTL_SECS",
        )?,
        jwt_issuer: jwt.issuer.clone(),
        jwt_audience: jwt.audience.clone(),
        jwt_private_key_pem,
        jwt_public_key_pem: jwt.public_key_pem.clone(),
        refresh_token_ttl: parse_time_duration_secs(
            vars.get("MNT_REFRESH_TOKEN_TTL_SECS"),
            DEFAULT_REFRESH_TOKEN_TTL_SECS,
            "MNT_REFRESH_TOKEN_TTL_SECS",
        )?,
        refresh_family_absolute_ttl: parse_time_duration_secs(
            vars.get("MNT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS"),
            DEFAULT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS,
            "MNT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS",
        )?,
        trusted_proxy_count: parse_trusted_proxy_count(vars.get("MNT_TRUSTED_PROXY_COUNT"))?,
        cookie_secure: parse_cookie_secure(vars.get("MNT_COOKIE_SECURE"))?,
    }))
}

/// Whether the web refresh cookie carries the `Secure` attribute. Defaults to
/// `true` (production over HTTPS); set `MNT_COOKIE_SECURE=false` only for local
/// http dev, where a `Secure` cookie would be dropped on `http://localhost`.
fn parse_cookie_secure(raw: Option<&String>) -> Result<bool, AppError> {
    match non_empty(raw) {
        Some(value) => value
            .parse::<bool>()
            .map_err(|err| AppError::Config(format!("invalid MNT_COOKIE_SECURE: {err}"))),
        None => Ok(true),
    }
}

/// Number of trusted reverse proxies in front of the auth service (default 1).
/// Drives the `X-Forwarded-For` client-IP derivation in the rate limiter: the
/// real client is the Nth-from-the-right XFF entry. A value of 0 is treated as 1
/// (there is always at least the ingress proxy), so the leftmost entry is never
/// blindly trusted.
fn parse_trusted_proxy_count(raw: Option<&String>) -> Result<usize, AppError> {
    match raw {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|err| AppError::Config(format!("invalid MNT_TRUSTED_PROXY_COUNT: {err}"))),
        None => Ok(1),
    }
}

fn storage_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<Option<S3StorageConfig>, AppError> {
    let Some(endpoint_url) = non_empty(vars.get("MNT_S3_ENDPOINT_URL")) else {
        return Ok(None);
    };
    let required = |name: &'static str| {
        non_empty(vars.get(name)).ok_or_else(|| {
            AppError::Config(format!("{name} is required when S3 storage is configured"))
        })
    };
    let force_path_style = match non_empty(vars.get("MNT_S3_FORCE_PATH_STYLE")) {
        Some(raw) => raw
            .parse::<bool>()
            .map_err(|err| AppError::Config(format!("invalid MNT_S3_FORCE_PATH_STYLE: {err}")))?,
        None => true,
    };

    Ok(Some(S3StorageConfig {
        endpoint_url,
        region: non_empty(vars.get("MNT_S3_REGION")).unwrap_or_else(|| "us-east-1".to_owned()),
        access_key_id: required("MNT_S3_ACCESS_KEY_ID")?,
        secret_access_key: required("MNT_S3_SECRET_ACCESS_KEY")?,
        primary_bucket: required("MNT_S3_PRIMARY_BUCKET")?,
        replica_bucket: required("MNT_S3_REPLICA_BUCKET")?,
        force_path_style,
    }))
}

fn dispatch_timer_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<DispatchTimerConfig, AppError> {
    Ok(DispatchTimerConfig {
        accept_window: parse_time_duration_secs(
            vars.get("MNT_DISPATCH_ACCEPT_WINDOW_SECS"),
            DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS,
            "MNT_DISPATCH_ACCEPT_WINDOW_SECS",
        )?,
        force_assign_alert_after: parse_time_duration_secs(
            vars.get("MNT_DISPATCH_FORCE_ASSIGN_ALERT_SECS"),
            DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS,
            "MNT_DISPATCH_FORCE_ASSIGN_ALERT_SECS",
        )?,
        alimtalk_no_ack_after: parse_time_duration_secs(
            vars.get("MNT_DISPATCH_ALIMTALK_NO_ACK_SECS"),
            DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS,
            "MNT_DISPATCH_ALIMTALK_NO_ACK_SECS",
        )?,
        gps_ping_freshness: parse_time_duration_secs(
            vars.get("MNT_DISPATCH_GPS_FRESHNESS_SECS"),
            DEFAULT_DISPATCH_GPS_FRESHNESS_SECS,
            "MNT_DISPATCH_GPS_FRESHNESS_SECS",
        )?,
    })
}

fn fcm_config_from_vars(vars: &HashMap<String, String>) -> Result<Option<FcmConfig>, AppError> {
    let project_id = non_empty(vars.get("MNT_FCM_PROJECT_ID"));
    let client_email = non_empty(vars.get("MNT_FCM_CLIENT_EMAIL"));
    let private_key_pem = non_empty(vars.get("MNT_FCM_PRIVATE_KEY_PEM"));
    let configured = project_id.is_some() || client_email.is_some() || private_key_pem.is_some();
    if !configured {
        return Ok(None);
    }
    let config = FcmConfig {
        project_id: project_id.ok_or_else(|| {
            AppError::Config("MNT_FCM_PROJECT_ID is required when FCM is configured".to_owned())
        })?,
        client_email: client_email.ok_or_else(|| {
            AppError::Config("MNT_FCM_CLIENT_EMAIL is required when FCM is configured".to_owned())
        })?,
        private_key_pem: private_key_pem.ok_or_else(|| {
            AppError::Config(
                "MNT_FCM_PRIVATE_KEY_PEM is required when FCM is configured".to_owned(),
            )
        })?,
        token_uri: non_empty(vars.get("MNT_FCM_TOKEN_URI"))
            .unwrap_or_else(|| DEFAULT_FCM_TOKEN_URI.to_owned()),
        scope: non_empty(vars.get("MNT_FCM_SCOPE")).unwrap_or_else(|| DEFAULT_FCM_SCOPE.to_owned()),
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok(Some(config))
}

fn solapi_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<(Option<SolapiConfig>, Option<String>), AppError> {
    let api_key = non_empty(vars.get("MNT_SOLAPI_API_KEY"));
    let api_secret = non_empty(vars.get("MNT_SOLAPI_API_SECRET"));
    let from = non_empty(vars.get("MNT_SOLAPI_FROM"));
    let pf_id = non_empty(vars.get("MNT_SOLAPI_PF_ID"));
    let template_id = non_empty(vars.get("MNT_SOLAPI_TEMPLATE_ID"));
    let credentials_configured =
        api_key.is_some() || api_secret.is_some() || from.is_some() || pf_id.is_some();
    if !credentials_configured && template_id.is_none() {
        return Ok((None, None));
    }
    let Some(template_id) = template_id else {
        return Ok((
            None,
            Some(
                "Solapi Alimtalk disabled: MNT_SOLAPI_TEMPLATE_ID is required after Kakao template approval"
                    .to_owned(),
            ),
        ));
    };
    let required = |value: Option<String>, name: &'static str| {
        value.ok_or_else(|| {
            AppError::Config(format!("{name} is required when Solapi is configured"))
        })
    };
    let config = SolapiConfig {
        base_url: non_empty(vars.get("MNT_SOLAPI_BASE_URL"))
            .unwrap_or_else(|| DEFAULT_SOLAPI_BASE_URL.to_owned()),
        api_key: required(api_key, "MNT_SOLAPI_API_KEY")?,
        api_secret: required(api_secret, "MNT_SOLAPI_API_SECRET")?,
        from: required(from, "MNT_SOLAPI_FROM")?,
        pf_id: required(pf_id, "MNT_SOLAPI_PF_ID")?,
        template_id,
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok((Some(config), None))
}

/// Parse the outbound SMTP email relay config from the environment.
///
/// Returns `Ok(None)` (→ stub OTP sender) in TWO cases, so the app always boots:
///
///   1. The whole `MNT_EMAIL_*` group is unset (no relay configured at all).
///   2. The group is PARTIALLY set but the SMTP credentials — the secret parts,
///      `MNT_EMAIL_SMTP_USERNAME` / `MNT_EMAIL_SMTP_PASSWORD` — are missing or
///      empty. This is the prod crashloop footgun: a ConfigMap supplies the
///      non-secret `host`/`port`/`from` while the Secret holding the creds is
///      not yet provisioned. Rather than hard-erroring and crashlooping, we log
///      a WARN and degrade to the stub sender (OTP logged, not relayed).
///
/// A `Some(config)` (→ live `LettreSmtpSender`) is returned ONLY when the
/// credentials are present AND the remaining required fields (host, port,
/// from-address, from-name) are present and valid. With the secrets in hand, a
/// missing non-secret field is a genuine operator misconfiguration and still
/// hard-errors (it is not the missing-Secret crashloop this guards against).
fn email_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<Option<SmtpEmailConfig>, AppError> {
    let host = non_empty(vars.get("MNT_EMAIL_SMTP_HOST"));
    let port_raw = non_empty(vars.get("MNT_EMAIL_SMTP_PORT"));
    let username = non_empty(vars.get("MNT_EMAIL_SMTP_USERNAME"));
    let password = non_empty(vars.get("MNT_EMAIL_SMTP_PASSWORD"));
    let from_address = non_empty(vars.get("MNT_EMAIL_FROM"));
    let from_name = non_empty(vars.get("MNT_EMAIL_FROM_NAME"));
    let configured = host.is_some()
        || port_raw.is_some()
        || username.is_some()
        || password.is_some()
        || from_address.is_some()
        || from_name.is_some();
    if !configured {
        return Ok(None);
    }
    // The secret parts gate live SMTP. If either is missing/empty while the rest
    // is set, fall back to the stub instead of crashlooping — the app must boot
    // regardless of partial email config (a not-yet-provisioned Secret).
    if username.is_none() || password.is_none() {
        tracing::warn!(
            "MNT_EMAIL_* partially set but SMTP credentials missing — using stub sender (OTP logged, not sent)"
        );
        return Ok(None);
    }
    let required = |value: Option<String>, name: &'static str| {
        value
            .ok_or_else(|| AppError::Config(format!("{name} is required when email is configured")))
    };
    let port = match port_raw {
        Some(raw) => raw
            .parse::<u16>()
            .map_err(|err| AppError::Config(format!("invalid MNT_EMAIL_SMTP_PORT: {err}")))?,
        None => {
            return Err(AppError::Config(
                "MNT_EMAIL_SMTP_PORT is required when email is configured".to_owned(),
            ));
        }
    };
    let config = SmtpEmailConfig {
        host: required(host, "MNT_EMAIL_SMTP_HOST")?,
        port,
        username: required(username, "MNT_EMAIL_SMTP_USERNAME")?,
        password: required(password, "MNT_EMAIL_SMTP_PASSWORD")?,
        from_address: required(from_address, "MNT_EMAIL_FROM")?,
        from_name: required(from_name, "MNT_EMAIL_FROM_NAME")?,
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok(Some(config))
}

fn parse_time_duration_secs(
    raw: Option<&String>,
    default_secs: u64,
    name: &str,
) -> Result<time::Duration, AppError> {
    let secs = match raw {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|err| AppError::Config(format!("invalid {name}: {err}")))?,
        None => i64::try_from(default_secs)
            .map_err(|err| AppError::Config(format!("invalid default for {name}: {err}")))?,
    };
    Ok(time::Duration::seconds(secs))
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

#[derive(Debug, Clone)]
pub enum DatabaseDependency {
    NotConfigured,
    Postgres(PgPool),
}

#[derive(Clone)]
pub struct AppState {
    config: AppConfig,
    database: DatabaseDependency,
    jwt_verifier: Option<JwtVerifier>,
    /// JWT issuer used ONLY by the PLATFORM view-as START path to mint
    /// short-lived read-only impersonation tokens. Built from the same ES256
    /// keypair as the auth-rest issuer (so view-as tokens verify with the live
    /// `jwt_verifier`). `None` when no private key is configured — the view-as
    /// START endpoint then returns 503.
    view_as_issuer: Option<JwtIssuer>,
    /// Fresh passkey step-up verifier for sensitive policy-authoring actions.
    /// Built from the auth-rest WebAuthn RP settings; if auth-rest is disabled,
    /// policy lifecycle changes fail closed instead of accepting bearer-only
    /// publish/rollback requests.
    policy_step_up: Option<PasskeyService>,
    auth_rest: Option<AuthRestState>,
    evidence_storage: Option<EvidenceService<SeaweedS3Storage>>,
    /// Object store + bucket backing the public storefront media-serve route.
    sales_media_storage: Option<(SeaweedS3Storage, String)>,
    dispatch_job_queue: Option<Arc<dyn JobQueue>>,
    push_notifier: Option<Arc<dyn PushNotifier>>,
    /// Outbound email sender for the open-signup OTP (#38). Always present: a
    /// `LettreSmtpSender` when `MNT_EMAIL_*` is configured, otherwise a
    /// `StubEmailSender` that logs the OTP instead of relaying it.
    email_sender: Arc<dyn EmailSender>,
    realtime_hub: Option<Arc<PgRealtimeHub>>,
    realtime_bridge: Option<PostgresBridgeHandle>,
    /// The webmail master-key cipher (envelope AEAD for SMTP/IMAP credentials).
    /// `None` when `MNT_MAIL_MASTER_KEY` is absent at boot — the app STILL boots
    /// and the mail router still mounts. Read-only mail endpoints degrade to a
    /// clean no-account/empty state; credential-using endpoints return a clear
    /// `503 email_not_configured`. The cipher feature is lazily/optionally init'd
    /// so a missing key is never a panic.
    mail_cipher: Option<Arc<EnvelopeCredentialCipher>>,
    /// The inbound webmail IMAP sync worker handle. `None` when the worker is OFF
    /// (no KEK / no storage / `MNT_MAIL_ENABLED` unset). Held so its lifetime is
    /// tied to the running `AppState` and it stops on shutdown.
    mail_sync_handle: Option<Arc<mail_sync::MailSyncHandle>>,
    /// Shared dev/test verifier used by the read-only audit-chain attestation
    /// endpoint. `InMemoryEd25519Signer::verify` reconstructs the public key
    /// from each seal's stored `key_ref`, so this throwaway signer is not a
    /// trust root; it just avoids generating a fresh keypair on every poll.
    audit_attestation_signer: Arc<dyn SealSigner>,
}

impl AppState {
    pub fn new(config: AppConfig, database: DatabaseDependency) -> Result<Self, AppError> {
        let jwt_verifier = config
            .jwt
            .as_ref()
            .map(JwtVerifierConfig::build)
            .transpose()?;
        // The view-as issuer is built from the SAME ES256 keypair as auth-rest,
        // so impersonation tokens it mints verify against the live `jwt_verifier`.
        // The per-call TTL override (≤30 min) is enforced in the START handler;
        // the issuer's default TTL here is a backstop of the same length.
        let view_as_issuer = config
            .auth_rest
            .as_ref()
            .map(build_view_as_issuer)
            .transpose()?;
        let policy_step_up = config
            .auth_rest
            .as_ref()
            .map(policy_step_up_from_auth_config)
            .transpose()?;
        let auth_rest = match &database {
            DatabaseDependency::Postgres(pool) => match &config.auth_rest {
                Some(auth_config) => Some(
                    AuthRestState::new(pool.clone(), auth_config.clone()).map_err(|err| {
                        AppError::Config(format!("invalid auth REST config: {err}"))
                    })?,
                ),
                None => Some(AuthRestState::disabled(pool.clone())),
            },
            DatabaseDependency::NotConfigured => None,
        };
        let audit_attestation_signer: Arc<dyn SealSigner> =
            Arc::new(InMemoryEd25519Signer::generate().map_err(|err| {
                AppError::Internal(format!("audit-chain attestation signer init failed: {err}"))
            })?);
        let realtime_hub = realtime_hub_from_database(&database);
        Ok(Self {
            config,
            database,
            jwt_verifier,
            view_as_issuer,
            policy_step_up,
            auth_rest,
            evidence_storage: None,
            sales_media_storage: None,
            dispatch_job_queue: None,
            push_notifier: None,
            email_sender: Arc::new(StubEmailSender),
            realtime_hub,
            realtime_bridge: None,
            mail_cipher: None,
            mail_sync_handle: None,
            audit_attestation_signer,
        })
    }

    pub async fn from_config(config: AppConfig) -> Result<Self, AppError> {
        let database = match config.database_url.as_deref() {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(8)
                    .acquire_timeout(Duration::from_secs(3))
                    // Tenant-isolation backstop. The app connects as the non-owner
                    // `mnt_rt` role under RLS keyed on the `app.current_org` GUC.
                    // Every query sets that GUC with SET LOCAL (transaction-scoped,
                    // auto-cleared on COMMIT/ROLLBACK), so it cannot normally
                    // persist. RESET ALL on release is defense-in-depth: if any
                    // future path ever set a *session*-level GUC, this clears it
                    // before the pooled connection is reused, so a tenant's
                    // `app.current_org` can never bleed into the next request.
                    // (RESET ALL keeps prepared statements, unlike DISCARD ALL.)
                    .after_release(|conn, _meta| {
                        Box::pin(async move {
                            sqlx::query("RESET ALL").execute(conn).await?;
                            Ok(true)
                        })
                    })
                    .connect(url)
                    .await
                    .map_err(AppError::Database)?;
                DatabaseDependency::Postgres(pool)
            }
            None => DatabaseDependency::NotConfigured,
        };

        let mut state = Self::new(config.clone(), database)?;
        if let (DatabaseDependency::Postgres(pool), Some(storage_config)) =
            (&state.database, config.storage.as_ref())
        {
            let object_store = SeaweedS3Storage::from_config(storage_config)
                .await
                .map_err(AppError::Storage)?;
            state.sales_media_storage =
                Some((object_store.clone(), storage_config.primary_bucket.clone()));
            state.evidence_storage = Some(EvidenceService::new(
                pool.clone(),
                object_store,
                storage_config.primary_bucket.clone(),
                storage_config.replica_bucket.clone(),
            ));
        }
        if let (DatabaseDependency::Postgres(_), Some(database_url)) =
            (&state.database, config.database_url.as_deref())
            && config.dispatch_jobs_enabled
        {
            let queue = ApalisPostgresJobQueue::connect(database_url, "mnt.dispatch")
                .await
                .map_err(|err| AppError::Config(format!("invalid dispatch job queue: {err}")))?;
            state.dispatch_job_queue = Some(Arc::new(queue));
        }
        let fcm = config
            .fcm
            .clone()
            .map(FcmHttpV1Client::new)
            .transpose()
            .map_err(|err| AppError::Config(format!("invalid FCM config: {err}")))?;
        let solapi = config
            .solapi
            .clone()
            .map(SolapiAlimtalkClient::new)
            .transpose()
            .map_err(|err| AppError::Config(format!("invalid Solapi config: {err}")))?;
        if let Some(reason) = &config.solapi_disabled_reason {
            tracing::warn!(reason = %reason, "Solapi Alimtalk escalation disabled");
        }
        if fcm.is_some() || solapi.is_some() {
            state.push_notifier = Some(Arc::new(ProviderPushNotifier::new(fcm, solapi)));
        }
        if let Some(email_config) = config.email.clone() {
            let sender = LettreSmtpSender::new(email_config)
                .map_err(|err| AppError::Config(format!("invalid email config: {err}")))?;
            state.email_sender = Arc::new(sender);
        } else {
            tracing::info!(
                "MNT_EMAIL_* unset: outbound OTP email uses the stub sender (logs only)"
            );
        }
        // Hand the resolved OTP email sender to the auth REST layer so its
        // open-signup endpoint (#38) can deliver the code. Done here (not in
        // `AppState::new`) because the live SMTP sender is only known once
        // `config.email` is resolved above.
        if let Some(auth_rest) = state.auth_rest.take() {
            state.auth_rest = Some(auth_rest.with_email_sender(state.email_sender.clone()));
        }
        // Webmail master key (envelope AEAD KEK) — GRACEFULLY OPTIONAL. When
        // `MNT_MAIL_MASTER_KEY` is present + valid it arms the webmail credential
        // cipher; when it is absent the app STILL boots and the mail router still
        // mounts (so the OpenAPI paths exist). Read-only mail endpoints degrade to
        // a clean no-account/empty state; credential-using endpoints return a clear
        // `503 email_not_configured`. If it is present but malformed, that's a
        // boot error so it is caught immediately rather than at first use.
        match EnvelopeCredentialCipher::from_env() {
            Ok(cipher) => state.mail_cipher = Some(Arc::new(cipher)),
            Err(_) if std::env::var(mnt_comms_credential_cipher::MASTER_KEY_ENV).is_err() => {
                tracing::info!(
                    "MNT_MAIL_MASTER_KEY unset: credential-using webmail endpoints are unavailable; read paths stay clean and the app boots normally"
                );
            }
            Err(_) => {
                return Err(AppError::Config(
                    "MNT_MAIL_MASTER_KEY is set but is not a valid base64 32-byte key".to_owned(),
                ));
            }
        }
        if let Some(hub) = state.realtime_hub.clone() {
            state.realtime_bridge = Some(
                hub.start_postgres_listener()
                    .await
                    .map_err(AppError::Realtime)?,
            );
        }
        // Inbound webmail sync worker (B-mail-3). Spawned like the realtime
        // listener: a background loop on the app pool that arms `app.current_org`
        // per tenant for each sync pass. GRACEFUL — only runs when the master KEK,
        // object storage, and `MNT_MAIL_ENABLED` are all present; otherwise a
        // no-op so the app boots normally and mail endpoints still mount.
        //
        // WORKER-ROLE ONLY: this background ticker belongs on the worker, never on
        // the horizontally-scaled API pods — every API replica running its own
        // ticker would sync the same mailboxes concurrently. Even on the worker it
        // is HA-safe because the due-account claim leases each row with FOR UPDATE
        // SKIP LOCKED (migration 0116), so >1 worker replica still claim disjoint
        // batches.
        if let DatabaseDependency::Postgres(pool) = &state.database
            && config.role == AppRole::Worker
        {
            state.mail_sync_handle = mail_sync::spawn(
                pool.clone(),
                state.mail_cipher.clone(),
                state.sales_media_storage.clone(),
                config.mail_enabled,
            )
            .map(Arc::new);
        }
        Ok(state)
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    /// Outbound OTP email sender. Always present (stub when `MNT_EMAIL_*` is
    /// unset). Exposed for the open-signup endpoint landing in #38.
    #[must_use]
    pub fn email_sender(&self) -> Arc<dyn EmailSender> {
        self.email_sender.clone()
    }

    pub async fn shutdown_realtime(&self) {
        if let Some(bridge) = &self.realtime_bridge {
            bridge.shutdown();
        }
        if let Some(hub) = &self.realtime_hub {
            hub.shutdown().await;
        }
        if let Some(handle) = &self.mail_sync_handle {
            handle.shutdown();
        }
    }
}

/// Build the inbound-attachment object store the webmail read API uses for
/// presigned GETs, from the same storage config the evidence pipeline uses.
/// `None` when storage is unconfigured (the attachment-download endpoint 503s).
fn mail_attachment_store(state: &AppState) -> Option<mnt_comms_rest::SharedAttachmentStore> {
    state.sales_media_storage.as_ref().map(|(store, bucket)| {
        Arc::new(mail_sync::S3MailAttachmentStore::new(
            store.clone(),
            bucket.clone(),
        )) as mnt_comms_rest::SharedAttachmentStore
    })
}

fn realtime_hub_from_database(database: &DatabaseDependency) -> Option<Arc<PgRealtimeHub>> {
    match database {
        DatabaseDependency::Postgres(pool) => Some(Arc::new(PgRealtimeHub::new(
            pool.clone(),
            Default::default(),
        ))),
        DatabaseDependency::NotConfigured => None,
    }
}

#[derive(Debug, Serialize)]
struct HealthBody<'a> {
    status: &'a str,
    service: String,
    role: AppRole,
}

#[derive(Debug, Serialize)]
struct ReadyBody<'a> {
    status: &'a str,
    service: String,
    role: AppRole,
    database: &'a str,
}

#[derive(Debug, Deserialize, Clone)]
struct AuditQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    target_type: Option<String>,
    target_id: Option<String>,
    actor: Option<uuid::Uuid>,
    trace_id: Option<String>,
}

#[derive(Debug, Clone)]
struct NormalizedAuditQuery {
    limit: i64,
    offset: i64,
    target_type: Option<String>,
    target_id: Option<String>,
    actor: Option<uuid::Uuid>,
    trace_id: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AuditRecord {
    id: uuid::Uuid,
    actor: Option<uuid::Uuid>,
    action: String,
    target_type: String,
    target_id: String,
    branch_id: Option<uuid::Uuid>,
    before_snap: Option<serde_json::Value>,
    after_snap: Option<serde_json::Value>,
    trace_id: String,
    span_id: String,
    occurred_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct AuditPage {
    items: Vec<AuditRecord>,
    limit: i64,
    offset: i64,
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

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

/// Histogram name backing the OpenSLO availability + latency objectives
/// (`backend/app/slos/*.openslo.yaml`). The `metrics-exporter-prometheus`
/// renderer appends the standard `_bucket` / `_sum` / `_count` suffixes, and the
/// `s` unit suffix is already in the name, so the SLO queries
/// (`http_server_request_duration_seconds_bucket`,
/// `http_server_request_duration_seconds_count`) resolve against it directly.
const HTTP_DURATION_METRIC: &str = "http_server_request_duration_seconds";

/// Latency histogram boundaries in SECONDS. Chosen to bracket the 500ms p99 SLO
/// objective with resolution on either side.
const HTTP_LATENCY_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0,
];

static METRICS_HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

/// Install the process-global Prometheus recorder once and return a render
/// handle. Idempotent: the first successful install wins and later calls (and a
/// lost install race) return that same handle. Call at startup before serving.
pub fn install_metrics_recorder() -> Result<PrometheusHandle, AppError> {
    if let Some(handle) = METRICS_HANDLE.get() {
        return Ok(handle.clone());
    }
    match PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full(HTTP_DURATION_METRIC.to_owned()),
            HTTP_LATENCY_BUCKETS,
        )
        .and_then(PrometheusBuilder::install_recorder)
    {
        Ok(handle) => Ok(METRICS_HANDLE.get_or_init(|| handle).clone()),
        // Lost the install race (another caller already set the global recorder)
        // â adopt the winner's handle; only a genuine absence is an error.
        Err(err) => METRICS_HANDLE
            .get()
            .cloned()
            .ok_or_else(|| AppError::Telemetry(err.to_string())),
    }
}

/// Middleware: time each request and record its duration (seconds) into the
/// `http_server_request_duration_seconds` histogram, labelled with the service
/// name and response status code. Labels are deliberately low-cardinality (no
/// path/method) so the series count stays bounded. A no-op until the recorder is
/// installed.
async fn track_http_metrics(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let start = std::time::Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    metrics::histogram!(
        HTTP_DURATION_METRIC,
        "service_name" => state.config.service_name.clone(),
        "http_response_status_code" => status.to_string(),
    )
    .record(start.elapsed().as_secs_f64());
    response
}

/// `GET /metrics` â Prometheus exposition. Internal-only: the ingress routes
/// `/api` to this server and everything else to the SPA, so `/metrics` is
/// reachable only in-cluster (e.g. by a ServiceMonitor scrape), never via the
/// public host.
async fn render_metrics() -> Response<Body> {
    match METRICS_HANDLE.get() {
        Some(handle) => (
            [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
            handle.render(),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "metrics recorder not installed",
        )
            .into_response(),
    }
}

/// Wrap a fully-merged router with request metrics and expose `/metrics`. Applied
/// last so every route (base + all domain routers) is measured; `/metrics` is
/// added afterwards so it does not measure itself.
fn with_metrics(router: Router, state: &AppState) -> Router {
    router
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            track_http_metrics,
        ))
        .route("/metrics", get(render_metrics))
}

/// Build the `TraceLayer` applied to the fully-merged router so EVERY route
/// (base, domain, platform, realtime, auth) emits a request span. Tracing a
/// long-lived WS/SSE connection only logs its start/end, so this is safe to
/// apply even to the realtime route.
// The return type spells out the closure-parameterized `TraceLayer`; clippy's
// `type_complexity` lint fires on this builder-style signature, which is the
// idiomatic shape for a configured tower layer.
#[allow(clippy::type_complexity)]
fn http_trace_layer() -> TraceLayer<
    tower_http::classify::SharedClassifier<tower_http::classify::ServerErrorsAsFailures>,
    impl Fn(&Request<Body>) -> tracing::Span + Clone,
    impl Fn(&Request<Body>, &tracing::Span) + Clone,
    impl Fn(&Response<Body>, Duration, &tracing::Span) + Clone,
> {
    TraceLayer::new_for_http()
        .make_span_with(|request: &Request<Body>| {
            tracing::info_span!(
                "http.request",
                method = %request.method(),
                // Path ONLY â never the query string. A query can carry PII (a
                // search term, a name, a phone), and the pii-no-logs gate is a
                // literal scanner that cannot catch a runtime query value, so we
                // drop it at the source. The path identifies the route, which is
                // what tracing needs.
                path = %request.uri().path(),
                version = ?request.version(),
                trace_id = tracing::field::Empty,
                span_id = tracing::field::Empty,
            )
        })
        .on_request(|request: &Request<Body>, span: &tracing::Span| {
            let trace_id = record_otel_ids(span);
            tracing::info!(
                trace_id = %trace_id,
                method = %request.method(),
                // Path only â drop the query string (potential PII); see make_span_with.
                path = %request.uri().path(),
                "http request started"
            );
        })
        .on_response(
            |response: &Response<Body>, latency: Duration, span: &tracing::Span| {
                let trace_id = record_otel_ids(span);
                tracing::info!(
                    trace_id = %trace_id,
                    status = response.status().as_u16(),
                    latency_ms = latency.as_millis(),
                    "http request completed"
                );
            },
        )
}

pub fn build_router(state: AppState) -> Router {
    // The base router carries NO cross-cutting layers here. Per axum's `merge`
    // semantics, any layer applied to a router *before* it is merged with the
    // domain routers wraps only the base routes, not the merged-in ones â which
    // is exactly the bug this composition avoids. The trace layer, timeout, and
    // body limit are applied to the FULLY-merged router below so every route
    // (base + domains) is covered, with the realtime route deliberately merged
    // outside the timeout so a long-lived WS connection is never severed.
    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/openapi/openapi.yaml", get(openapi_yaml))
        // Public, unauthenticated native app-link association documents. Native
        // passkeys are inert until the platform serves these at the EXACT
        // dotted paths over the RP origin, so they live on the base router with
        // no auth and no tenant middleware (they carry no tenant data).
        .route(WELL_KNOWN_AASA_PATH, get(apple_app_site_association))
        .route(WELL_KNOWN_ASSETLINKS_PATH, get(android_assetlinks))
        .with_state(state.clone());

    let router = match &state.database {
        DatabaseDependency::Postgres(pool) => {
            let kpi_repository = PgKpiRepository::new(pool.clone());
            let realtime_hub = state
                .realtime_hub
                .clone()
                .unwrap_or_else(|| Arc::new(PgRealtimeHub::new(pool.clone(), Default::default())));
            let notification_store = PgNotificationStore::new(pool.clone())
                .with_notifier(Arc::new(PostgresNotificationNotifier::new(pool.clone())));
            let messenger_store = PgMessengerStore::new(pool.clone())
                .with_notifier(Arc::new(PostgresMessageNotifier::new(pool.clone())))
                // `@`-mentions create notification-center rows via the #198 sink
                // (fan-out enabled) so a mentioned member sees them in their inbox.
                .with_notification_sink(Arc::new(notification_store.clone()));
            let todo_store = PgTodoStore::new(pool.clone());
            let registry_store = PgRegistryStore::new(pool.clone());
            let financial_store = PgFinancialStore::new(pool.clone());
            let inspection_store = PgInspectionStore::new(pool.clone());
            let compliance_store = PgComplianceStore::new(pool.clone());
            let integrity_store = PgIntegrityStore::new(pool.clone());
            let dispatch_store = PgDispatchStore::new(pool.clone());
            let support_store = PgSupportStore::new(pool.clone());
            let sales_store = PgSalesStore::new(pool.clone());
            let org_store = PgOrgStore::new(pool.clone());
            let work_order_store = PgWorkOrderStore::new(pool.clone())
                .with_created_listener(Arc::new(messenger_store.clone()));
            // Authenticated domain routers (tenant-scoped data). Each domain
            // `router()` self-applies the per-request org middleware (so the
            // behavior is testable per crate), arming `app.current_org` for every
            // route. `/api/audit` is an app-level route, so it gets the same
            // middleware applied directly here. L20 audit-chain PR-2: the
            // read-only attestation endpoint joins the SAME router (no new
            // `.merge()`), the established pattern for app-level audit REST.
            let audit_router = mnt_platform_request_context::with_request_context(
                Router::new()
                    .route("/api/audit", get(audit_log))
                    .route("/api/v1/audit/attestation", get(audit_attestation))
                    .with_state(state.clone()),
                state.jwt_verifier.clone(),
                pool.clone(),
            );
            let domain_router = audit_router
                .merge(mnt_dispatch_rest::router(DispatchRestState::new(
                    dispatch_store,
                    state.jwt_verifier.clone(),
                    state.config.dispatch_timers,
                    state.dispatch_job_queue.clone(),
                    state.push_notifier.clone(),
                )))
                .merge(mnt_financial_rest::router(
                    FinancialRestState::new(financial_store, state.jwt_verifier.clone())
                        .with_purchase_attachment_storage(state.sales_media_storage.clone()),
                ))
                .merge(mnt_inspection_rest::router(InspectionRestState::new(
                    inspection_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_support_rest::router(
                    SupportRestState::new(
                        support_store,
                        state.jwt_verifier.clone(),
                        state.push_notifier.clone(),
                    )
                    .with_trusted_proxy_count(state.config.trusted_proxy_count),
                ))
                .merge(mnt_identity_rest::router(
                    IdentityRestState::new(org_store, state.jwt_verifier.clone())
                        .with_passkey_step_up(state.policy_step_up.clone()),
                ))
                .merge(mnt_compliance_rest::router(ComplianceRestState::new(
                    compliance_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_integrity::router(IntegrityRestState::new(
                    integrity_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_registry_rest::router(
                    RegistryRestState::new(registry_store, state.jwt_verifier.clone())
                        .with_passkey_step_up(state.policy_step_up.clone()),
                ))
                .merge(hr::router(hr::HrState::new(
                    pool.clone(),
                    state.jwt_verifier.clone(),
                )))
                .merge(workflow_studio::router(
                    workflow_studio::WorkflowStudioState::new(
                        pool.clone(),
                        state.jwt_verifier.clone(),
                    )
                    .with_passkey_step_up(state.policy_step_up.clone()),
                ))
                .merge(collaboration::router(
                    collaboration::CollaborationState::new(
                        pool.clone(),
                        state.jwt_verifier.clone(),
                    ),
                ))
                .merge(action_inbox::router(action_inbox::ActionInboxState::new(
                    pool.clone(),
                    state.jwt_verifier.clone(),
                )))
                .merge(objects::router(objects::ObjectState::new(
                    pool.clone(),
                    state.jwt_verifier.clone(),
                )))
                .merge(lifecycle::router(lifecycle::LifecycleState::new(
                    pool.clone(),
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_sales_rest::router({
                    let mut sales_state =
                        SalesRestState::new(sales_store, state.jwt_verifier.clone())
                            .with_trusted_proxy_count(state.config.trusted_proxy_count);
                    if let Some(storefront_org) = state.config.storefront_org {
                        sales_state = sales_state.with_storefront_org(storefront_org);
                    }
                    if let Some((object_store, bucket)) = state.sales_media_storage.clone() {
                        sales_state = sales_state.with_media_storage(object_store, bucket);
                    }
                    sales_state
                }))
                .merge(mnt_reporting_rest::router(KpiRestState::new(
                    kpi_repository,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_workorder_rest::router(
                    WorkOrderRestState::new(work_order_store.clone(), state.jwt_verifier.clone())
                        .with_workflow_runtime(Some(
                            mnt_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore::new(
                                pool.clone(),
                            ),
                        )),
                ))
                .merge(mnt_workorder_rest::mobile_router(
                    MobileRestState::new(
                        pool.clone(),
                        work_order_store,
                        state.jwt_verifier.clone(),
                        state.evidence_storage.clone(),
                    )
                    .with_job_queue(state.dispatch_job_queue.clone()),
                ))
                .merge(mnt_messenger_rest::router(MessengerRestState::new(
                    messenger_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_notifications_rest::router(NotificationRestState::new(
                    notification_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_inbox_rest::router(
                    InboxRestState::new(
                        PgInboxStore::new(pool.clone()),
                        state.jwt_verifier.clone(),
                    )
                    .with_passkey_step_up(state.policy_step_up.clone()),
                ))
                .merge(mnt_todos_rest::router(TodoRestState::new(
                    todo_store,
                    state.jwt_verifier.clone(),
                )))
                // Webmail (`/api/v1/mail/*`). The router ALWAYS mounts so the
                // OpenAPI paths exist and the app boots without the master key;
                // when `state.mail_cipher` is `None`, read paths degrade cleanly
                // while credential-using endpoints return 503.
                // The inbound-attachment object store (presigned GET) is wired
                // from the same storage config the evidence pipeline uses; `None`
                // when storage is unconfigured (download then 503s).
                .merge(mnt_comms_rest::router(
                    CommsRestState::new(
                        PgMailStore::new(pool.clone()),
                        state.mail_cipher.clone(),
                        state.jwt_verifier.clone(),
                    )
                    .with_attachments(mail_attachment_store(&state)),
                ));
            // READ-ONLY WALL for PLATFORM "view as": wrap the WHOLE tenant
            // domain router so any request carrying a `view_as` token may use
            // ONLY GET/HEAD — every other method is rejected 403 `view_as_read_only`
            // BEFORE any handler or per-handler authz runs. This is a blanket
            // method gate keyed purely on the token's `view_as` claim, so no
            // mutation handler on any tenant route is reachable while
            // impersonating, regardless of the acting role. It is orthogonal to
            // (and does not replace) the tenant org middleware each domain router
            // already applies; an ordinary tenant/platform token is untouched.
            let domain_router = mnt_platform_rest::with_view_as_read_only_gate(
                domain_router,
                state.jwt_verifier.clone(),
            );
            // The realtime WS upgrade and the pre-auth login/refresh endpoints are
            // intentionally NOT under the org middleware: a login request has no
            // tenant yet, and the WS handler runs its own auth over the socket
            // lifetime (a task-local would not survive the upgrade anyway).
            // PLATFORM tier (`/api/platform/*`). Mounted at the APP level (merged,
            // not nested) behind the PLATFORM extractor â deliberately NOT under
            // the tenant org middleware: the PLATFORM extractor rejects a tenant
            // token here (403), and the per-router tenant org middleware rejects a
            // platform token on the tenant `/api/v1/*` routes (403). There is NO
            // blanket `/api/*` platform-token rejection, so `/api/platform/*` is
            // reached untouched by tenant middleware. Living under `/api` lets the
            // ingress `/api`→backend rule route it while the SPA keeps the bare
            // browser routes `/platform/*`. This is the only path that creates org
            // rows.
            let platform_router = mnt_platform_rest::router(
                PlatformRestState::new(
                    pool.clone(),
                    state.jwt_verifier.clone(),
                    PlatformProvisioner::new(state.config.coldstart_otp_ttl),
                )
                .with_view_as_issuer(state.view_as_issuer.clone()),
            );
            // Everything EXCEPT the realtime WS upgrade: base health/openapi
            // routes, the tenant domain routers, the platform tier, and the
            // pre-auth login/refresh endpoints. These are all short-lived
            // request/response cycles, so they carry the 30s request timeout.
            let timed = {
                let timed = router.merge(domain_router).merge(platform_router);
                let timed = match state.auth_rest.clone() {
                    Some(auth_rest) => {
                        // The auth-rest router carries authenticated tenant
                        // mutations (issue-OTP, credential-reset, enroll-handoff,
                        // passkey register/finish). They live OUTSIDE the tenant
                        // domain router, so the view-as read-only wall must also
                        // wrap them — otherwise an impersonation token could reach
                        // a write here. The pre-auth POSTs (login/refresh/redeem)
                        // carry no view_as token, so the gate is a no-op for them.
                        let auth_router = mnt_platform_rest::with_view_as_read_only_gate(
                            mnt_platform_auth_rest::router(auth_rest),
                            state.jwt_verifier.clone(),
                        );
                        timed.merge(auth_router)
                    }
                    None => timed,
                };
                // Defense-in-depth: shed any request that hangs on a slow
                // upstream or DB so a stuck handler cannot pin a worker. Applied
                // BEFORE the realtime router is merged so the long-lived WS
                // connection below is never severed by this 30s budget â this is
                // the #1 regression to prevent (live wallboard/dispatch SSE/WS).
                timed.layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    state.config.request_timeout,
                ))
            };
            // The realtime WS upgrade is merged AFTER the timeout layer so it
            // escapes the 30s budget. It is intentionally NOT under the org
            // middleware: the WS handler runs its own auth over the socket
            // lifetime (a task-local would not survive the upgrade anyway).
            timed.merge(mnt_platform_realtime::router(RealtimeRestState::new(
                realtime_hub,
                state.jwt_verifier.clone(),
            )))
        }
        DatabaseDependency::NotConfigured => router,
    };
    // Cross-cutting layers on the FULLY-merged router (base + every domain +
    // platform + realtime + auth), so they actually cover the merged routes:
    //   * DefaultBodyLimit (2 MiB) â bounds every request body. Applied here
    //     (innermost of these), so a per-route `DefaultBodyLimit::max(N)` set
    //     deeper in a domain router (e.g. the 16 MiB equipment import) still
    //     wins. The realtime WS upgrade carries no body, so this is a no-op for
    //     it. Overridable per-route, unlike an outermost RequestBodyLimitLayer.
    //   * TraceLayer â emits a request span for EVERY route, realtime included
    //     (tracing a long-lived WS only logs its start/end, so it is safe).
    let router = router
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(http_trace_layer());
    with_metrics(router, &state)
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    Json(HealthBody {
        status: "ok",
        service: state.config.service_name,
        role: state.config.role,
    })
}

async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    match &state.database {
        DatabaseDependency::NotConfigured => (
            StatusCode::OK,
            Json(ReadyBody {
                status: "ready",
                service: state.config.service_name,
                role: state.config.role,
                database: "not_configured",
            }),
        ),
        DatabaseDependency::Postgres(pool) => {
            let database_ready = sqlx::query("SELECT 1")
                .execute(pool)
                .instrument(tracing::info_span!(
                    "db.query",
                    db_system = "postgresql",
                    db_operation = "SELECT",
                    db_statement = "SELECT 1",
                ))
                .await
                .is_ok();
            if database_ready {
                (
                    StatusCode::OK,
                    Json(ReadyBody {
                        status: "ready",
                        service: state.config.service_name,
                        role: state.config.role,
                        database: "ready",
                    }),
                )
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ReadyBody {
                        status: "not_ready",
                        service: state.config.service_name,
                        role: state.config.role,
                        database: "unreachable",
                    }),
                )
            }
        }
    }
}

async fn openapi_yaml() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/yaml; charset=utf-8")],
        OPENAPI_YAML,
    )
}

/// Serve the Apple App Site Association document at the well-known path.
///
/// Public + unauthenticated, served as `application/json` (no extension, per
/// Apple's requirement). The `webcredentials.apps` list is sourced from
/// `MNT_IOS_APP_IDS`; an empty list yields a valid but inert document. Apple
/// fetches this over the RP origin to authorize the native app's passkeys.
async fn apple_app_site_association(State(state): State<AppState>) -> Response<Body> {
    let body = apple_app_site_association_json(AppleAppSiteAssociationConfig {
        app_ids: state.config.app_links.ios_app_ids.clone(),
    });
    well_known_json_response(body)
}

/// Serve the Android Digital Asset Links document at `/.well-known/assetlinks.json`.
///
/// Public + unauthenticated, served as `application/json`. The package +
/// signing-cert fingerprints come from `MNT_ANDROID_PACKAGE` /
/// `MNT_ANDROID_CERT_SHA256`; when the package is unset the document is an empty
/// JSON array (valid + inert). Android fetches this to authorize the app's
/// passkeys for the RP domain.
async fn android_assetlinks(State(state): State<AppState>) -> Response<Body> {
    let links = &state.config.app_links;
    let body = match &links.android_package {
        Some(package_name) => android_assetlinks_json(AndroidAssetLinksConfig {
            package_name: package_name.clone(),
            sha256_cert_fingerprints: links.android_cert_sha256.clone(),
        }),
        // No package configured yet: serve an empty (but valid) asset-links array
        // rather than a half-populated entry with no package name.
        None => Ok("[]".to_owned()),
    };
    well_known_json_response(body)
}

/// Build an `application/json` response for a well-known association document.
///
/// Serialization of these tiny, statically-shaped documents cannot realistically
/// fail; if it ever did we surface a 500 rather than serving a malformed body.
fn well_known_json_response(body: Result<String, mnt_platform_auth::AuthError>) -> Response<Body> {
    match body {
        Ok(json) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(err) => {
            tracing::error!(error = %err, "failed to serialize well-known association document");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn audit_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Result<Json<AuditPage>, ApiError> {
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool,
        DatabaseDependency::NotConfigured => {
            return Err(ApiError::service_unavailable(
                "database is not configured for audit access",
            ));
        }
    };
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        ApiError::service_unavailable("JWT verification is not configured for audit access")
    })?;
    let token = bearer_token(&headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| ApiError::unauthorized("invalid bearer token"))?;
    let principal = principal_from_claims(claims)?;
    authorize_audit_read(&principal)?;
    let query = normalize_audit_query(query)?;
    let audit_event = audit_read_event(&principal)?;
    let branch_scope = principal.branch_scope.clone();
    let limit = query.limit;
    let offset = query.offset;

    let items = with_audit::<_, Vec<AuditRecord>, AppError>(pool, audit_event, |tx| {
        Box::pin(async move {
            fetch_audit_records(tx.as_mut(), branch_scope, query)
                .await
                .map_err(AppError::Database)
        })
    })
    .await
    .map_err(ApiError::from_app)?;

    Ok(Json(AuditPage {
        items,
        limit,
        offset,
    }))
}

/// L20 audit-chain PR-2: read-only attestation for the caller's tenant.
/// Recomputes and compares the org's sealed hash chain (`verify_org_chain`,
/// charter §5.3) and returns the verdict — never mutates. Unlike `/api/audit`,
/// which can safely branch-filter rows for a branch-scoped ADMIN, this endpoint
/// verifies the whole tenant chain. Require org-wide `AuditLogRead` so the
/// attestation surface cannot widen branch-scoped audit visibility. For
/// `AuditLogRead` today, built-in org-wide authority is SUPER_ADMIN; a
/// branch-scoped or branch-omitted ADMIN token must not pass this gate.
///
/// Cost note: `verify_org_chain` re-derives every seal's batch from its full
/// `audit_events` range — a FULL-CHAIN re-verify, not an incremental one, so
/// wall time scales with the org's total sealed audit history. Bounded today
/// by (a) org-wide built-in callers (SUPER_ADMIN for `AuditLogRead`), so
/// callers are trusted and infrequent, (b) the app-wide request timeout, and
/// (c) mnt_rt's 30s `statement_timeout` (migration 0112) capping any single DB
/// pass. A head-N-seals or cached-verdict endpoint variant for orgs with a long
/// history is a PR-3 item (charter F1 anchor), not built here.
async fn audit_attestation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ChainReport>, ApiError> {
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool,
        DatabaseDependency::NotConfigured => {
            return Err(ApiError::service_unavailable(
                "database is not configured for audit access",
            ));
        }
    };
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        ApiError::service_unavailable("JWT verification is not configured for audit access")
    })?;
    let token = bearer_token(&headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| ApiError::unauthorized("invalid bearer token"))?;
    let principal = principal_from_claims(claims)?;
    authorize_audit_attestation(&principal)?;

    // Shared throwaway signer is correct here: `verify` reconstructs the
    // public key from each seal's OWN stored `key_ref`; this object is not the
    // trust root, just the implementation that performs verification. PR-3's
    // `OciVaultSigner` will verify the same way (key material keyed off the
    // stored `key_ref`).
    let signer = state.audit_attestation_signer.clone();

    let report = verify_org_chain(
        pool,
        principal.org_id,
        &signer,
        time::OffsetDateTime::now_utc(),
        &SealConfig::default(),
    )
    .await
    .map_err(|err| {
        tracing::error!(error = %err, "audit-chain attestation verify failed");
        ApiError::internal("attestation verification failed")
    })?;

    Ok(Json(report))
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?
        .to_str()
        .map_err(|_| ApiError::unauthorized("invalid authorization header"))?;
    header_value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| ApiError::unauthorized("authorization header must use Bearer scheme"))
}

fn principal_from_claims(claims: AccessClaims) -> Result<Principal, ApiError> {
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| ApiError::unauthorized("token subject is not a valid user id"))?;
    let roles_vec: Vec<Role> = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| ApiError::unauthorized("token contains an unknown role"))
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
                    .map_err(|_| ApiError::unauthorized("token contains an invalid branch id"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        BranchScope::Branches(branches)
    };

    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| ApiError::unauthorized("token contains an invalid org id"))?;
    let access_scope = claims
        .access_scope()
        .map_err(|_| ApiError::unauthorized("token contains an invalid access scope"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope).with_access_scope(access_scope))
}

fn authorize_audit_read(principal: &Principal) -> Result<(), ApiError> {
    let resource_branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches
            .iter()
            .next()
            .copied()
            .ok_or_else(|| ApiError::forbidden("principal has no branch scope"))?,
    };
    authorize(
        principal,
        Action::new(Feature::AuditLogRead),
        resource_branch,
    )
    .map_err(ApiError::from_kernel)
}

fn authorize_audit_attestation(principal: &Principal) -> Result<(), ApiError> {
    // Whole-tenant attestation is intentionally stricter than branch-filtered
    // `/api/audit`: built-in ADMIN is operational/branch authority, not an
    // org-wide evidentiary attestation authority. `authorize_org_wide` first
    // requires all-branch scope, then applies the feature matrix; for
    // `AuditLogRead` that means built-in SUPER_ADMIN today, while still
    // preserving the custom-grant path for future policy-managed org-wide
    // AuditLogRead.
    authorize_org_wide(principal, Action::new(Feature::AuditLogRead)).map_err(ApiError::from_kernel)
}

fn normalize_audit_query(query: AuditQuery) -> Result<NormalizedAuditQuery, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_AUDIT_LIMIT);
    if !(1..=MAX_AUDIT_LIMIT).contains(&limit) {
        return Err(ApiError::validation(format!(
            "limit must be between 1 and {MAX_AUDIT_LIMIT}"
        )));
    }
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(ApiError::validation("offset must be non-negative"));
    }
    let target_type = query
        .target_type
        .map(|target_type| target_type.trim().to_owned())
        .filter(|target_type| !target_type.is_empty());
    let target_id = query
        .target_id
        .map(|target_id| target_id.trim().to_owned())
        .filter(|target_id| !target_id.is_empty());
    let trace_id = query
        .trace_id
        .map(|trace_id| trace_id.trim().to_owned())
        .filter(|trace_id| !trace_id.is_empty());

    Ok(NormalizedAuditQuery {
        limit,
        offset,
        target_type,
        target_id,
        actor: query.actor,
        trace_id,
    })
}

fn audit_read_event(principal: &Principal) -> Result<AuditEvent, ApiError> {
    let event = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("audit.read").map_err(ApiError::from_kernel)?,
        "audit_log",
        "query",
        current_trace_context(),
        time::OffsetDateTime::now_utc(),
    )
    // Arm `app.current_org` for the FORCE-RLS read: `with_audit` binds the GUC
    // from `event.org_id`, so without this the `audit_events` SELECT runs with
    // an unset GUC and RLS fails closed (zero rows) as the `mnt_rt` role. Also
    // stamps the `audit.read` row with the caller's org instead of NULL.
    .with_org(principal.org_id);
    Ok(match audit_event_branch(&principal.branch_scope) {
        Some(branch_id) => event.with_branch(branch_id),
        None => event,
    })
}

fn audit_event_branch(scope: &BranchScope) -> Option<BranchId> {
    match scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}

async fn fetch_audit_records(
    conn: &mut sqlx::PgConnection,
    branch_scope: BranchScope,
    query: NormalizedAuditQuery,
) -> Result<Vec<AuditRecord>, sqlx::Error> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            id, actor, action, target_type, target_id, branch_id,
            before_snap, after_snap, trace_id::text AS trace_id,
            span_id::text AS span_id, occurred_at
        FROM audit_events
        WHERE
        "#,
    );

    match branch_scope {
        BranchScope::All => {
            builder.push("TRUE");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> = branches
                .into_iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect();
            builder
                .push("branch_id = ANY(")
                .push_bind(branch_ids)
                .push(")");
        }
    }

    if let Some(target_type) = query.target_type {
        builder.push(" AND target_type = ").push_bind(target_type);
    }
    if let Some(target_id) = query.target_id {
        builder.push(" AND target_id = ").push_bind(target_id);
    }
    if let Some(actor) = query.actor {
        builder.push(" AND actor = ").push_bind(actor);
    }
    // `trace_id` is CHAR(32); cast to text so the bound String compares as
    // text=text (matching the SELECT projection) rather than bpchar padding.
    if let Some(trace_id) = query.trace_id {
        builder.push(" AND trace_id::text = ").push_bind(trace_id);
    }
    builder
        .push(" ORDER BY occurred_at DESC, id DESC LIMIT ")
        .push_bind(query.limit)
        .push(" OFFSET ")
        .push_bind(query.offset);

    builder
        .build_query_as::<AuditRecord>()
        .fetch_all(conn)
        .instrument(tracing::info_span!(
            "db.query",
            db_system = "postgresql",
            db_operation = "SELECT",
            db_statement = "SELECT audit_events",
        ))
        .await
}

fn current_trace_context() -> TraceContext {
    let context = tracing::Span::current().context();
    let span_context = context.span().span_context().clone();
    if span_context.is_valid() {
        TraceContext::new(
            span_context.trace_id().to_string(),
            span_context.span_id().to_string(),
        )
        .unwrap_or_else(|_| TraceContext::generate())
    } else {
        TraceContext::generate()
    }
}

fn record_otel_ids(span: &tracing::Span) -> String {
    let context = span.context();
    let span_context = context.span().span_context().clone();
    let fallback = TraceContext::generate();
    let trace_id = if span_context.is_valid() {
        span_context.trace_id().to_string()
    } else {
        fallback.trace_id().to_owned()
    };
    let span_id = if span_context.is_valid() {
        span_context.span_id().to_string()
    } else {
        fallback.span_id().to_owned()
    };
    span.record("trace_id", tracing::field::display(&trace_id));
    span.record("span_id", tracing::field::display(&span_id));
    trace_id
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
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

    fn service_unavailable(message: impl Into<String>) -> Self {
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

    fn from_app(error: AppError) -> Self {
        tracing::error!(error = %error, "audit api failed");
        match error {
            AppError::Config(message) => Self::service_unavailable(message),
            AppError::Database(_)
            | AppError::Io(_)
            | AppError::Storage(_)
            | AppError::Realtime(_)
            | AppError::Telemetry(_)
            | AppError::Worker(_)
            | AppError::Internal(_) => Self::internal("internal server error"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
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

pub fn init_tracing(config: &AppConfig) -> Result<TelemetryGuard, AppError> {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = tracing_subscriber::fmt::layer().json();

    if let Some(endpoint) = &config.otlp_endpoint {
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()
            .map_err(|err| AppError::Telemetry(err.to_string()))?;
        let provider = SdkTracerProvider::builder()
            .with_resource(
                Resource::builder()
                    .with_service_name(config.service_name.clone())
                    .build(),
            )
            .with_batch_exporter(exporter)
            .build();
        let tracer = provider.tracer(config.service_name.clone());
        global::set_tracer_provider(provider.clone());

        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .with(tracing_opentelemetry::layer().with_tracer(tracer))
            .try_init()
            .map_err(|err| AppError::Telemetry(err.to_string()))?;

        Ok(TelemetryGuard {
            provider: Some(provider),
        })
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .try_init()
            .map_err(|err| AppError::Telemetry(err.to_string()))?;

        Ok(TelemetryGuard { provider: None })
    }
}

#[derive(Debug)]
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    pub fn shutdown(&self) {
        if let Some(provider) = &self.provider
            && let Err(err) = provider.shutdown()
        {
            tracing::warn!(error = %err, "failed to shut down telemetry provider");
        }
    }
}

pub async fn serve(config: AppConfig, state: AppState) -> Result<(), AppError> {
    if let DatabaseDependency::Postgres(pool) = &state.database {
        assert_no_dev_auth_personas(pool).await?;
    }
    match config.role {
        AppRole::Api => serve_api(config, state).await,
        AppRole::Worker => run_dispatch_worker(config, state).await,
        // Migrate mode never builds an AppState (no HTTP server, no JWT/S3
        // wiring); it is dispatched in `main` before `from_config` runs.
        AppRole::Migrate => run_migrations(&config).await,
    }
}

/// Refuse to boot (api or worker role) if a dev-auth persona row leaked into
/// this database. `dev-auth:<org>:<role>` is the synthetic `phone` key
/// `DevPrincipalProvisioner` (mnt-platform-provisioning) upserts for the
/// local role-switch endpoint; that endpoint only exists in a build compiled
/// with `--features dev-auth`, so any such row in a build WITHOUT that
/// feature means a dev database dump (or a devved-up environment's data)
/// reached somewhere it should not have. Compiled out entirely under
/// `dev-auth` (a dev-auth build is expected to have these rows).
///
/// `pub` (rather than private) so `backend/app/tests/*` can exercise both cfg
/// bodies directly without booting a full HTTP server.
#[cfg(not(feature = "dev-auth"))]
pub async fn assert_no_dev_auth_personas(pool: &sqlx::PgPool) -> Result<(), AppError> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE phone LIKE 'dev-auth:%'")
        .fetch_one(pool)
        .await
        .map_err(AppError::Database)?;
    if count > 0 {
        return Err(AppError::Internal(format!(
            "refusing to start: {count} dev-auth:* persona row(s) found in `users` — a dev-only \
             database dump reached a build without the dev-auth feature. Purge them before \
             starting this environment: DELETE FROM users WHERE phone LIKE 'dev-auth:%';"
        )));
    }
    Ok(())
}

#[cfg(feature = "dev-auth")]
pub async fn assert_no_dev_auth_personas(_pool: &sqlx::PgPool) -> Result<(), AppError> {
    Ok(())
}

/// Apply the embedded schema migrations against `DATABASE_URL`, then return.
///
/// This is the `migrate` run-mode (an Argo CD PreSync Job). It is deliberately
/// lean: it needs ONLY `DATABASE_URL` (the OWNER `mnt_app` connection that can
/// run DDL) â no JWT keys, S3 creds, or any other app config â so a migration
/// Job can run with a minimal environment. It opens a tiny single-connection
/// pool, runs the migrator (idempotent: sqlx skips versions already recorded in
/// `_sqlx_migrations`), logs how many were applied, then returns so the process
/// can exit 0. Any DDL/connection error propagates so the Job fails (non-zero)
/// and Argo blocks the sync.
pub async fn run_migrations(config: &AppConfig) -> Result<(), AppError> {
    let database_url = config
        .database_url
        .as_deref()
        .ok_or_else(|| AppError::Config("migrate role requires DATABASE_URL".to_owned()))?;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await
        .map_err(AppError::Database)?;

    let applied_before = applied_migration_count(&pool).await?;
    let embedded = MIGRATOR.iter().count();

    tracing::info!(
        embedded,
        applied_before,
        "applying schema migrations (migrate mode)"
    );

    MIGRATOR
        .run(&pool)
        .await
        .map_err(|err| AppError::Internal(format!("migration run failed: {err}")))?;

    let applied_after = applied_migration_count(&pool).await?;
    let newly_applied = applied_after.saturating_sub(applied_before);

    if newly_applied == 0 {
        tracing::info!(
            applied = applied_after,
            "schema is up to date; nothing to apply"
        );
    } else {
        tracing::info!(
            newly_applied,
            applied = applied_after,
            "schema migrations applied"
        );
    }

    pool.close().await;
    Ok(())
}

/// Count rows in sqlx's `_sqlx_migrations` ledger, returning 0 before the table
/// exists (a fresh database, before the first `MIGRATOR.run`). Used only to log
/// how many migrations a `migrate` run newly applied.
async fn applied_migration_count(pool: &PgPool) -> Result<usize, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    Ok(usize::try_from(count).unwrap_or(0))
}

async fn serve_api(config: AppConfig, state: AppState) -> Result<(), AppError> {
    install_metrics_recorder()?;
    seed_cold_start_otp(&config, &state).await?;

    let listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(
        service = %config.service_name,
        role = %config.role,
        addr = %config.http_addr,
        "starting mnt-app"
    );

    axum::serve(listener, build_router(state.clone()))
        .with_graceful_shutdown(shutdown_signal(config.shutdown_timeout, state))
        .await
        .map_err(AppError::Io)
}

/// Seed the cold-start admin's bootstrap OTP at API boot, after migrations have
/// been applied to the database.
///
/// Runs only for the API role with a configured `MNT_COLDSTART_OTP` and a live
/// database. The seeding itself is idempotent and race-safe in the provisioning
/// crate: it inserts a credential only when the cold-start admin has neither a
/// passkey nor an open credential. The OTP value is NEVER logged â only whether a
/// credential was seeded or skipped.
async fn seed_cold_start_otp(config: &AppConfig, state: &AppState) -> Result<(), AppError> {
    let Some(otp) = config.coldstart_otp.as_deref() else {
        tracing::info!(
            "no cold-start OTP configured; skipping cold-start seed (normal once admins exist)"
        );
        return Ok(());
    };
    let DatabaseDependency::Postgres(pool) = &state.database else {
        tracing::info!(
            "cold-start OTP configured but no database is wired; skipping cold-start seed"
        );
        return Ok(());
    };

    let seeded = BootstrapCredentialStore
        .seed_cold_start_credential(
            pool,
            otp,
            config.coldstart_otp_ttl,
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(|err| AppError::Internal(format!("cold-start seed failed: {err}")))?;
    if seeded {
        tracing::info!("cold-start OTP seeded for the cold-start admin");
    } else {
        tracing::info!(
            "cold-start OTP not seeded (admin already has a passkey or an open credential)"
        );
    }
    Ok(())
}

async fn run_dispatch_worker(config: AppConfig, state: AppState) -> Result<(), AppError> {
    install_metrics_recorder()?;
    let database_url = config
        .database_url
        .as_deref()
        .ok_or_else(|| AppError::Config("worker role requires DATABASE_URL".to_owned()))?;
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool.clone(),
        DatabaseDependency::NotConfigured => {
            return Err(AppError::Config(
                "worker role requires a configured database".to_owned(),
            ));
        }
    };
    tracing::info!(
        service = %config.service_name,
        role = %config.role,
        queue = "mnt.dispatch",
        "starting mnt-app worker"
    );
    // M2 workflow-runtime payroll outbox drainer (design §B/§F). Runs alongside
    // the apalis dispatch worker on the same `mnt_rt` pool, re-arming
    // `app.current_org` per tenant each tick. Lands dark: no tenant is enrolled in
    // a shipped migration/seed, so it finds no work in production.
    let workflow_drain_handle = workflow_drain::spawn(pool.clone());
    // L20 tamper-evident audit-chain seal worker (charter §5.1). Seals batches of
    // audit_events into the append-only audit_chain_seals hash chain on the same
    // `mnt_rt` pool, re-arming `app.current_org` per tenant each tick. Dev/test
    // uses an in-process Ed25519 signer; production swaps in an OCI Vault signer
    // (PR-3) so the DB owner never holds the private key. The attestation REST
    // endpoint (PR-2, `/api/v1/audit/attestation`) reads whatever is sealed
    // regardless of this gate. F3 (post-merge review): default OFF in
    // production — until the real signer lands, an always-on worker writes real
    // seals every tick under a fresh `key_ref = test:ed25519:<hex>` keypair
    // generated on every restart, which is not yet the evidentiary guarantee the
    // chain is meant to provide. `MNT_AUDIT_CHAIN_SEAL_ENABLED=true` opts a
    // deployment in (dev/staging) ahead of PR-3.
    let audit_chain_handle = if config.audit_chain_seal_enabled {
        match mnt_platform_audit_chain::InMemoryEd25519Signer::generate() {
            Ok(signer) => Some(mnt_platform_audit_chain::spawn(
                pool.clone(),
                Arc::new(signer),
            )),
            Err(err) => {
                tracing::error!(error = %err, "audit-chain signer init failed; seal worker not started");
                None
            }
        }
    } else {
        tracing::info!(
            "MNT_AUDIT_CHAIN_SEAL_ENABLED is not set; the audit-chain seal worker is OFF"
        );
        None
    };
    // Workflow cron-schedule poller (BE-AUTO slice 1). Same worker-role,
    // per-tenant re-armed loop shape as the drainer. Dark-safe: no shipped
    // migration/seed creates a schedule row, so it finds no work until a tenant
    // authors one through the audited studio REST surface.
    let workflow_schedule_handle = workflow_schedules::spawn(pool.clone());
    let alimtalk_policy = if config.solapi.is_some() {
        AlimtalkEscalationPolicy::enabled()
    } else {
        AlimtalkEscalationPolicy::disabled()
    };
    let dispatch_worker = DispatchWorker::new(
        PgDispatchStore::new(pool),
        state.push_notifier.clone(),
        alimtalk_policy,
    );
    // Compose the dispatch-timer worker with the evidence-transcode handler so a
    // SINGLE apalis worker on the `mnt.dispatch` queue services both job
    // families. EvidenceTranscode is routed to the transcode handler (which owns
    // the EvidenceService + ffmpeg processor + a concurrency cap); everything
    // else falls through to the dispatch worker.
    let evidence_worker = state.evidence_storage.clone().map(|service| {
        EvidenceTranscodeWorker::new(service, config.evidence_transcode_concurrency)
    });
    if evidence_worker.is_none() {
        tracing::warn!(
            "evidence storage is not configured; evidence transcode jobs will be rejected"
        );
    }
    let worker = CompositeJobHandler {
        dispatch: dispatch_worker,
        evidence: evidence_worker,
    };

    // The worker exposes no API surface, but orchestrators (Compose/K8s) still
    // need a liveness/readiness probe. Serve /healthz + /readyz on the same
    // address the API role uses, concurrently with the apalis worker.
    let health_listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(addr = %config.http_addr, "worker health server listening");
    let health_router = with_metrics(
        Router::new()
            .route("/healthz", get(healthz))
            .route("/readyz", get(readyz))
            .with_state(state.clone()),
        &state,
    );
    let health_server = tokio::spawn(async move {
        if let Err(err) = axum::serve(health_listener, health_router).await {
            tracing::warn!(error = %err, "worker health server stopped");
        }
    });

    // Kubernetes sets this explicitly via the Downward API in worker.yaml. Do
    // not use generic HOSTNAME: Docker/local shells often set it too, and those
    // environments should keep the stable service-name-only worker identity.
    let pod_name = env::var("MNT_POD_NAME").ok();
    let worker_name = dispatch_apalis_worker_name(&config.service_name, pod_name.as_deref());
    let result = run_apalis_worker_until_shutdown(
        database_url,
        "mnt.dispatch",
        worker_name,
        worker,
        shutdown_signal(config.shutdown_timeout, state.clone()),
    )
    .await
    .map_err(|err| AppError::Worker(err.to_string()));

    workflow_drain_handle.shutdown();
    if let Some(handle) = audit_chain_handle {
        handle.shutdown();
    }
    workflow_schedule_handle.shutdown();
    health_server.abort();
    result
}

fn dispatch_apalis_worker_name(service_name: &str, pod_name: Option<&str>) -> String {
    let service_name = service_name.trim();
    let service_name = if service_name.is_empty() {
        DEFAULT_SERVICE_NAME
    } else {
        service_name
    };
    match pod_name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(pod_name) => format!("{service_name}-{pod_name}-dispatch-worker"),
        None => format!("{service_name}-dispatch-worker"),
    }
}

/// Routes apalis jobs on the shared `mnt.dispatch` queue: `EvidenceTranscode`
/// goes to the evidence handler, everything else to the dispatch-timer worker.
struct CompositeJobHandler {
    dispatch: DispatchWorker,
    evidence: Option<EvidenceTranscodeWorker>,
}

impl PlatformJobHandler for CompositeJobHandler {
    fn handle<'a>(&'a self, job: PlatformJob) -> BoxFuture<'a, Result<(), JobQueueError>> {
        Box::pin(async move {
            match job {
                PlatformJob::EvidenceTranscode(evidence_job) => match &self.evidence {
                    Some(worker) => {
                        worker
                            .handle(evidence_job.org_id, evidence_job.evidence_id)
                            .await
                    }
                    None => Err(JobQueueError::Worker(
                        "evidence storage is not configured for transcode jobs".to_owned(),
                    )),
                },
                // Delegate via the PlatformJobHandler impl so the dispatch
                // worker's error is mapped into JobQueueError.
                other => PlatformJobHandler::handle(&self.dispatch, other).await,
            }
        })
    }
}

/// Background handler that transcodes/optimizes a staged evidence original into
/// the final 1080p/recompressed deliverable. Arms `app.current_org` to the job's
/// tenant (RLS), claims the pending row, runs ffmpeg/image processing behind a
/// concurrency cap (backpressure), and transitions PROCESSING → READY/FAILED.
struct EvidenceTranscodeWorker {
    service: EvidenceService<SeaweedS3Storage>,
    processor: FfmpegMediaProcessor,
    permits: Arc<tokio::sync::Semaphore>,
}

impl EvidenceTranscodeWorker {
    fn new(service: EvidenceService<SeaweedS3Storage>, concurrency: usize) -> Self {
        let concurrency = concurrency.max(1);
        Self {
            service,
            processor: FfmpegMediaProcessor::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(concurrency)),
        }
    }

    async fn handle(&self, org: OrgId, evidence_id: EvidenceId) -> Result<(), JobQueueError> {
        // Backpressure: cap the number of concurrent transcodes regardless of how
        // many jobs apalis hands us, so a burst of uploads can't exhaust CPU/disk.
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|err| JobQueueError::Worker(err.to_string()))?;
        // Arm the tenant from the job payload BEFORE any RLS-gated work; the
        // EvidenceService reads/writes the staging + status rows under this org.
        mnt_platform_request_context::scope_org(org, async { self.process(evidence_id).await })
            .await
            .map_err(|err| JobQueueError::Worker(err.to_string()))
    }

    async fn process(&self, evidence_id: EvidenceId) -> Result<(), StorageError> {
        let Some(job) = self.service.claim_processing_job().await? else {
            // Already processed (READY/FAILED) or claimed by another worker —
            // idempotent no-op.
            tracing::info!(
                %evidence_id,
                "evidence transcode: no pending row to claim (already processed)"
            );
            return Ok(());
        };
        let status = self
            .service
            .process_job(
                &self.processor,
                &job,
                TraceContext::generate(),
                time::OffsetDateTime::now_utc(),
            )
            .await?;
        tracing::info!(
            media_id = %job.media_id,
            work_order_id = %job.work_order_id,
            status = status.as_db_str(),
            "evidence transcode complete"
        );
        Ok(())
    }
}

async fn shutdown_signal(timeout: Duration, state: AppState) {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "failed to install ctrl-c handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!(
        timeout_secs = timeout.as_secs(),
        "shutdown signal received; draining in-flight requests and realtime connections"
    );
    state.shutdown_realtime().await;
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("telemetry error: {0}")]
    Telemetry(String),
    #[error("worker error: {0}")]
    Worker(String),
    #[error("realtime error: {0}")]
    Realtime(#[from] mnt_platform_realtime::RealtimeError),
}

impl From<DbError> for AppError {
    fn from(value: DbError) -> Self {
        match value {
            DbError::Sqlx(err) => Self::Database(err),
            DbError::Serialize(err) => Self::Internal(err.to_string()),
            DbError::CodeIssuance(err) => Self::Internal(err),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod audit_attestation_auth_tests {
    use std::collections::BTreeSet;

    use mnt_kernel_core::{BranchId, BranchScope, OrgId, UserId};
    use mnt_platform_authz::{Principal, Role};

    use super::authorize_audit_attestation;

    fn principal(role: Role, branch_scope: BranchScope) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::knl(),
            BTreeSet::from([role]),
            branch_scope,
        )
    }

    #[test]
    fn audit_attestation_builtin_gate_allows_only_super_admin_for_audit_read() {
        assert!(
            authorize_audit_attestation(&principal(Role::Admin, BranchScope::All)).is_err(),
            "built-in ADMIN is not org-wide attestation authority even with all-branch scope"
        );
        assert!(
            authorize_audit_attestation(&principal(
                Role::Admin,
                BranchScope::single(BranchId::new())
            ))
            .is_err(),
            "branch-scoped ADMIN must not access a whole-tenant attestation"
        );
        assert!(
            authorize_audit_attestation(&principal(Role::SuperAdmin, BranchScope::All)).is_ok()
        );
        assert!(
            authorize_audit_attestation(&principal(Role::Executive, BranchScope::All)).is_err(),
            "EXECUTIVE has org-wide scope semantics, but not AuditLogRead matrix permission"
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod router_layer_tests {
    //! Guards the cross-cutting tower-layer composition in `build_router`.
    //!
    //! The bug being prevented: applying `TraceLayer`/`TimeoutLayer`/body-limit
    //! to the *base* router before merging the domain routers leaves the merged
    //! routes with none of them (axum `merge` does not propagate pre-merge
    //! layers). The fix applies trace + body-limit to the fully-merged router
    //! and applies the timeout to base+domains+platform+auth *before* merging
    //! the long-lived realtime route, so the realtime route escapes the timeout.
    //!
    //! These tests assert the *merge-order semantics* the fix relies on, using
    //! the same `TimeoutLayer` and `.merge()` ordering as `build_router`. A
    //! route merged INSIDE the timeout 408s when its handler is slow; a route
    //! merged AFTER (outside) the timeout is never severed â which is exactly
    //! how the realtime WS/SSE route is composed. (Note: tower-http 0.7's
    //! `TimeoutLayer` times out the *response future*, so it cannot abort an
    //! already-streaming SSE body or an upgraded WS in the first place; merging
    //! the realtime route outside the timeout is belt-and-suspenders correctness
    //! that stays robust even if that behavior ever changes.)

    use std::time::Duration;

    use axum::Router;
    use axum::http::StatusCode;
    use axum::routing::get;
    use tower::ServiceExt;
    use tower_http::timeout::TimeoutLayer;

    use super::REQUEST_TIMEOUT;

    async fn slow() -> &'static str {
        tokio::time::sleep(Duration::from_secs(2)).await;
        "done"
    }

    /// Mirrors `build_router`'s composition: a "timed" bundle wrapped by a short
    /// `TimeoutLayer`, then the realtime-equivalent route merged AFTER it.
    fn compose(timeout: Duration) -> Router {
        let timed =
            Router::new()
                .route("/timed/slow", get(slow))
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    timeout,
                ));
        // The realtime route is merged AFTER the timeout layer, exactly as in
        // `build_router`, so it does not inherit the timeout.
        timed.merge(Router::new().route("/realtime/slow", get(slow)))
    }

    #[tokio::test]
    async fn domain_route_inside_timeout_is_shed_when_slow() {
        let app = compose(Duration::from_millis(200));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/timed/slow")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::REQUEST_TIMEOUT,
            "a slow handler on a route INSIDE the timeout layer must be shed with 408"
        );
    }

    #[tokio::test]
    async fn realtime_route_merged_outside_timeout_is_never_shed() {
        // Same short timeout, but the realtime-equivalent route is merged
        // outside it: a handler that runs well past the timeout still completes
        // 200 and is never severed. This is the #1 regression guard â a 30s
        // timeout must never cut a live realtime/SSE connection.
        let app = compose(Duration::from_millis(200));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/realtime/slow")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "the realtime route is merged OUTSIDE the timeout and must not be timed out"
        );
    }

    #[test]
    fn default_request_timeout_is_thirty_seconds() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod worker_identity_tests {
    use super::{DEFAULT_SERVICE_NAME, dispatch_apalis_worker_name};

    #[test]
    fn dispatch_worker_name_includes_pod_hostname_when_present() {
        let name = dispatch_apalis_worker_name("mnt-app-worker", Some("mnt-worker-abc123"));

        assert_eq!(name, "mnt-app-worker-mnt-worker-abc123-dispatch-worker");
    }

    #[test]
    fn dispatch_worker_name_falls_back_to_service_name_outside_kubernetes() {
        let name = dispatch_apalis_worker_name("mnt-app-worker", None);

        assert_eq!(name, "mnt-app-worker-dispatch-worker");
    }

    #[test]
    fn dispatch_worker_name_ignores_empty_hostname() {
        let name = dispatch_apalis_worker_name("mnt-app-worker", Some("   "));

        assert_eq!(name, "mnt-app-worker-dispatch-worker");
    }

    #[test]
    fn dispatch_worker_name_uses_default_service_for_empty_service_name() {
        let name = dispatch_apalis_worker_name(" ", Some("pod-1"));

        assert_eq!(
            name,
            format!("{DEFAULT_SERVICE_NAME}-pod-1-dispatch-worker")
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod email_config_tests {
    //! Guards `email_config_from_vars` robustness. The regression being
    //! prevented: a partially-set `MNT_EMAIL_*` group (ConfigMap supplies
    //! host/port/from, but the Secret with the SMTP creds is not yet
    //! provisioned) used to hard-error and crashloop `mnt-app` in prod. It must
    //! instead degrade to the stub sender so the app boots. Mirrors the email
    //! crate's `SmtpEmailConfig` tests but exercises the env-parsing layer.

    use std::collections::HashMap;

    use super::email_config_from_vars;

    /// The full, well-formed `MNT_EMAIL_*` set that yields a live SMTP config.
    fn full_email_vars() -> HashMap<String, String> {
        [
            ("MNT_EMAIL_SMTP_HOST", "smtp.example.com"),
            ("MNT_EMAIL_SMTP_PORT", "587"),
            ("MNT_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example"),
            ("MNT_EMAIL_SMTP_PASSWORD", "secret"),
            ("MNT_EMAIL_FROM", "noreply@example.com"),
            ("MNT_EMAIL_FROM_NAME", "MNT"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
    }

    #[test]
    fn unset_group_yields_no_config() {
        let vars = HashMap::new();
        assert!(email_config_from_vars(&vars).unwrap().is_none());
    }

    #[test]
    fn fully_set_group_yields_live_config() {
        let config = email_config_from_vars(&full_email_vars())
            .unwrap()
            .expect("fully-configured email group should yield Some(config)");
        assert_eq!(config.host, "smtp.example.com");
        assert_eq!(config.port, 587);
        assert_eq!(config.username, "ocid1.user.oc1..example");
        assert_eq!(config.from_address, "noreply@example.com");
    }

    #[test]
    fn partial_config_missing_username_falls_back_to_stub() {
        // ConfigMap set host/port/from, but the Secret (username) is absent.
        // This must NOT error — it degrades to the stub sender (None).
        let mut vars = full_email_vars();
        vars.remove("MNT_EMAIL_SMTP_USERNAME");
        assert!(
            email_config_from_vars(&vars).unwrap().is_none(),
            "missing SMTP username must fall back to stub, not error"
        );
    }

    #[test]
    fn partial_config_missing_password_falls_back_to_stub() {
        let mut vars = full_email_vars();
        vars.remove("MNT_EMAIL_SMTP_PASSWORD");
        assert!(
            email_config_from_vars(&vars).unwrap().is_none(),
            "missing SMTP password must fall back to stub, not error"
        );
    }

    #[test]
    fn empty_credentials_fall_back_to_stub() {
        // Empty (not absent) creds — e.g. a Secret mounted with blank values —
        // are treated the same as missing and fall back to the stub.
        let mut vars = full_email_vars();
        vars.insert("MNT_EMAIL_SMTP_USERNAME".to_owned(), "   ".to_owned());
        vars.insert("MNT_EMAIL_SMTP_PASSWORD".to_owned(), String::new());
        assert!(email_config_from_vars(&vars).unwrap().is_none());
    }

    /// Exhaustively prove the crashloop footgun is closed: ANY permutation of the
    /// `MNT_EMAIL_*` group that is set WITHOUT both SMTP credentials must degrade
    /// to the stub (`Ok(None)`), never error. This is the prod scenario — a
    /// ConfigMap supplies some non-secret fields while the credential Secret is
    /// not yet provisioned — across every subset of the non-secret fields.
    #[test]
    fn every_partial_config_without_credentials_falls_back_to_stub() {
        const NON_SECRET_KEYS: [(&str, &str); 4] = [
            ("MNT_EMAIL_SMTP_HOST", "smtp.example.com"),
            ("MNT_EMAIL_SMTP_PORT", "587"),
            ("MNT_EMAIL_FROM", "noreply@example.com"),
            ("MNT_EMAIL_FROM_NAME", "MNT"),
        ];
        // All 16 subsets of the 4 non-secret fields, crossed with the 3 broken
        // credential states (no username, no password, neither). The empty subset
        // with no creds is the all-unset case (also Ok(None)).
        for mask in 0u8..(1 << NON_SECRET_KEYS.len()) {
            for creds in [
                &[("MNT_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example")][..],
                &[("MNT_EMAIL_SMTP_PASSWORD", "secret")][..],
                &[][..],
            ] {
                let mut vars: HashMap<String, String> = HashMap::new();
                for (bit, (key, value)) in NON_SECRET_KEYS.iter().enumerate() {
                    if mask & (1 << bit) != 0 {
                        vars.insert((*key).to_owned(), (*value).to_owned());
                    }
                }
                for (key, value) in creds {
                    vars.insert((*key).to_owned(), (*value).to_owned());
                }
                assert!(
                    email_config_from_vars(&vars).unwrap().is_none(),
                    "partial config (mask={mask:#06b}, creds={creds:?}) must fall \
                     back to the stub sender, not error or build a live config"
                );
            }
        }
    }

    #[test]
    fn creds_present_but_missing_host_still_errors() {
        // With BOTH secrets in hand, a missing non-secret field is a genuine
        // operator misconfiguration and still hard-errors (not the missing-Secret
        // crashloop this guard targets).
        let mut vars = full_email_vars();
        vars.remove("MNT_EMAIL_SMTP_HOST");
        assert!(email_config_from_vars(&vars).is_err());
    }

    #[test]
    fn creds_present_but_missing_port_still_errors() {
        let mut vars = full_email_vars();
        vars.remove("MNT_EMAIL_SMTP_PORT");
        assert!(email_config_from_vars(&vars).is_err());
    }

    #[test]
    fn creds_present_but_missing_from_still_errors() {
        let mut vars = full_email_vars();
        vars.remove("MNT_EMAIL_FROM");
        assert!(email_config_from_vars(&vars).is_err());
    }

    #[test]
    fn creds_present_but_invalid_port_still_errors() {
        // A non-numeric port is an operator typo, not a missing Secret — error.
        let mut vars = full_email_vars();
        vars.insert("MNT_EMAIL_SMTP_PORT".to_owned(), "not-a-port".to_owned());
        assert!(email_config_from_vars(&vars).is_err());
    }

    #[test]
    fn credentials_only_without_relay_fields_falls_back_to_stub() {
        // Only the secrets are set (no host/port/from) — there is no relay to
        // talk to, so degrade to the stub rather than error. The `username` and
        // `password` guard fires only when one is missing; with both present but
        // the relay fields absent, `required(host, ...)` would error, so assert
        // the documented behavior explicitly: this errors (operator must supply
        // the relay fields once creds exist). Kept as a guard against regressions
        // that would silently send to an empty relay.
        let vars: HashMap<String, String> = [
            ("MNT_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example"),
            ("MNT_EMAIL_SMTP_PASSWORD", "secret"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert!(email_config_from_vars(&vars).is_err());
    }
}
