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
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Request, Response, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use mnt_compliance_adapter_postgres::PgComplianceStore;
use mnt_compliance_rest::ComplianceRestState;
use mnt_dispatch_adapter_postgres::PgDispatchStore;
use mnt_dispatch_domain::DispatchTimerConfig;
use mnt_dispatch_rest::DispatchRestState;
use mnt_dispatch_worker::{AlimtalkEscalationPolicy, DispatchWorker};
use mnt_financial_adapter_postgres::PgFinancialStore;
use mnt_financial_rest::FinancialRestState;
use mnt_inspection_adapter_postgres::PgInspectionStore;
use mnt_inspection_rest::InspectionRestState;
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, TraceContext, UserId,
};
use mnt_messenger_adapter_postgres::PgMessengerStore;
use mnt_messenger_rest::MessengerRestState;
use mnt_platform_auth::{AccessClaims, JwtSettings, JwtVerifier};
use mnt_platform_auth_rest::{AuthRestConfig, AuthRestState};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_jobs::{ApalisPostgresJobQueue, JobQueue, run_apalis_worker_until_shutdown};
use mnt_platform_push::{
    FcmConfig, FcmHttpV1Client, ProviderPushNotifier, PushNotifier, SolapiAlimtalkClient,
    SolapiConfig,
};
use mnt_platform_realtime::{
    PgRealtimeHub, PostgresBridgeHandle, PostgresMessageNotifier, RealtimeRestState,
};
use mnt_platform_storage::{EvidenceService, S3StorageConfig, SeaweedS3Storage, StorageError};
use mnt_registry_adapter_postgres::PgRegistryStore;
use mnt_registry_rest::RegistryRestState;
use mnt_reporting_adapter_postgres::PgKpiRepository;
use mnt_reporting_rest::KpiRestState;
use mnt_support_adapter_postgres::PgSupportStore;
use mnt_support_rest::SupportRestState;
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
use tower_http::trace::TraceLayer;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const DEFAULT_HTTP_ADDR: &str = "0.0.0.0:8080";
const DEFAULT_SERVICE_NAME: &str = "mnt-app";
const DEFAULT_SHUTDOWN_TIMEOUT_SECS: u64 = 10;
const DEFAULT_JWT_ISSUER: &str = "mnt-platform-auth";
const DEFAULT_JWT_AUDIENCE: &str = "mnt-api";
const DEFAULT_WEBAUTHN_RP_NAME: &str = "MNT Maintenance";
const DEFAULT_AUTH_CEREMONY_TTL_SECS: u64 = 300;
const DEFAULT_REFRESH_TOKEN_TTL_SECS: u64 = 60 * 60 * 24 * 30;
const DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS: u64 = 5 * 60;
const DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS: u64 = 10 * 60;
const DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS: u64 = 2 * 60;
const DEFAULT_DISPATCH_GPS_FRESHNESS_SECS: u64 = 15 * 60;
const DEFAULT_FCM_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_SOLAPI_BASE_URL: &str = "https://api.solapi.com";
const DEFAULT_AUDIT_LIMIT: i64 = 50;
const MAX_AUDIT_LIMIT: i64 = 200;
const OPENAPI_YAML: &str = include_str!("../../openapi/openapi.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRole {
    Api,
    Worker,
}

impl Display for AppRole {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api => f.write_str("api"),
            Self::Worker => f.write_str("worker"),
        }
    }
}

impl std::str::FromStr for AppRole {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "api" => Ok(Self::Api),
            "worker" => Ok(Self::Worker),
            other => Err(AppError::Config(format!(
                "MNT_APP_ROLE must be api or worker, got {other:?}"
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
    pub fcm: Option<FcmConfig>,
    pub solapi: Option<SolapiConfig>,
    pub solapi_disabled_reason: Option<String>,
    pub shutdown_timeout: Duration,
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
        let fcm = fcm_config_from_vars(&vars)?;
        let (solapi, solapi_disabled_reason) = solapi_config_from_vars(&vars)?;
        let shutdown_timeout = match vars.get("MNT_SHUTDOWN_TIMEOUT_SECS") {
            Some(raw) => raw.parse::<u64>().map(Duration::from_secs).map_err(|err| {
                AppError::Config(format!("invalid MNT_SHUTDOWN_TIMEOUT_SECS: {err}"))
            })?,
            None => Duration::from_secs(DEFAULT_SHUTDOWN_TIMEOUT_SECS),
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
            fcm,
            solapi,
            solapi_disabled_reason,
            shutdown_timeout,
        })
    }
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
    }))
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
    auth_rest: Option<AuthRestState>,
    evidence_storage: Option<EvidenceService<SeaweedS3Storage>>,
    dispatch_job_queue: Option<Arc<dyn JobQueue>>,
    push_notifier: Option<Arc<dyn PushNotifier>>,
    realtime_hub: Option<Arc<PgRealtimeHub>>,
    realtime_bridge: Option<PostgresBridgeHandle>,
}

impl AppState {
    pub fn new(config: AppConfig, database: DatabaseDependency) -> Result<Self, AppError> {
        let jwt_verifier = config
            .jwt
            .as_ref()
            .map(JwtVerifierConfig::build)
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
        let realtime_hub = realtime_hub_from_database(&database);
        Ok(Self {
            config,
            database,
            jwt_verifier,
            auth_rest,
            evidence_storage: None,
            dispatch_job_queue: None,
            push_notifier: None,
            realtime_hub,
            realtime_bridge: None,
        })
    }

    pub async fn from_config(config: AppConfig) -> Result<Self, AppError> {
        let database = match config.database_url.as_deref() {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(8)
                    .acquire_timeout(Duration::from_secs(3))
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
        if let Some(hub) = state.realtime_hub.clone() {
            state.realtime_bridge = Some(
                hub.start_postgres_listener()
                    .await
                    .map_err(AppError::Realtime)?,
            );
        }
        Ok(state)
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    pub async fn shutdown_realtime(&self) {
        if let Some(bridge) = &self.realtime_bridge {
            bridge.shutdown();
        }
        if let Some(hub) = &self.realtime_hub {
            hub.shutdown().await;
        }
    }
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
    actor: Option<uuid::Uuid>,
}

#[derive(Debug, Clone)]
struct NormalizedAuditQuery {
    limit: i64,
    offset: i64,
    target_type: Option<String>,
    actor: Option<uuid::Uuid>,
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

pub fn build_router(state: AppState) -> Router {
    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/api/audit", get(audit_log))
        .route("/openapi/openapi.yaml", get(openapi_yaml))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request<Body>| {
                    tracing::info_span!(
                        "http.request",
                        method = %request.method(),
                        uri = %request.uri(),
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
                        uri = %request.uri(),
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
                ),
        )
        .with_state(state.clone());

    match &state.database {
        DatabaseDependency::Postgres(pool) => {
            let kpi_repository = PgKpiRepository::new(pool.clone());
            let realtime_hub = state
                .realtime_hub
                .clone()
                .unwrap_or_else(|| Arc::new(PgRealtimeHub::new(pool.clone(), Default::default())));
            let messenger_store = PgMessengerStore::new(pool.clone())
                .with_notifier(Arc::new(PostgresMessageNotifier::new(pool.clone())));
            let registry_store = PgRegistryStore::new(pool.clone());
            let financial_store = PgFinancialStore::new(pool.clone());
            let inspection_store = PgInspectionStore::new(pool.clone());
            let compliance_store = PgComplianceStore::new(pool.clone());
            let dispatch_store = PgDispatchStore::new(pool.clone());
            let support_store = PgSupportStore::new(pool.clone());
            let work_order_store = PgWorkOrderStore::new(pool.clone())
                .with_created_listener(Arc::new(messenger_store.clone()));
            let router = router
                .merge(mnt_dispatch_rest::router(DispatchRestState::new(
                    dispatch_store,
                    state.jwt_verifier.clone(),
                    state.config.dispatch_timers,
                    state.dispatch_job_queue.clone(),
                    state.push_notifier.clone(),
                )))
                .merge(mnt_financial_rest::router(FinancialRestState::new(
                    financial_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_inspection_rest::router(InspectionRestState::new(
                    inspection_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_support_rest::router(SupportRestState::new(
                    support_store,
                    state.jwt_verifier.clone(),
                    state.push_notifier.clone(),
                )))
                .merge(mnt_compliance_rest::router(ComplianceRestState::new(
                    compliance_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_registry_rest::router(RegistryRestState::new(
                    registry_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_reporting_rest::router(KpiRestState::new(
                    kpi_repository,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_workorder_rest::router(WorkOrderRestState::new(
                    work_order_store.clone(),
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_workorder_rest::mobile_router(MobileRestState::new(
                    pool.clone(),
                    work_order_store,
                    state.jwt_verifier.clone(),
                    state.evidence_storage.clone(),
                )))
                .merge(mnt_messenger_rest::router(MessengerRestState::new(
                    messenger_store,
                    state.jwt_verifier.clone(),
                )))
                .merge(mnt_platform_realtime::router(RealtimeRestState::new(
                    realtime_hub,
                    state.jwt_verifier.clone(),
                )));
            match state.auth_rest.clone() {
                Some(auth_rest) => router.merge(mnt_platform_auth_rest::router(auth_rest)),
                None => router,
            }
        }
        DatabaseDependency::NotConfigured => router,
    }
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

    Ok(Principal::new(user_id, roles, branch_scope))
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

    Ok(NormalizedAuditQuery {
        limit,
        offset,
        target_type,
        actor: query.actor,
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
    );
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
    if let Some(actor) = query.actor {
        builder.push(" AND actor = ").push_bind(actor);
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
    match config.role {
        AppRole::Api => serve_api(config, state).await,
        AppRole::Worker => run_dispatch_worker(config, state).await,
    }
}

async fn serve_api(config: AppConfig, state: AppState) -> Result<(), AppError> {
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

async fn run_dispatch_worker(config: AppConfig, state: AppState) -> Result<(), AppError> {
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
    let alimtalk_policy = if config.solapi.is_some() {
        AlimtalkEscalationPolicy::enabled()
    } else {
        AlimtalkEscalationPolicy::disabled()
    };
    let worker = DispatchWorker::new(
        PgDispatchStore::new(pool),
        state.push_notifier.clone(),
        alimtalk_policy,
    );

    // The worker exposes no API surface, but orchestrators (Compose/K8s) still
    // need a liveness/readiness probe. Serve /healthz + /readyz on the same
    // address the API role uses, concurrently with the apalis worker.
    let health_listener = tokio::net::TcpListener::bind(config.http_addr)
        .await
        .map_err(AppError::Io)?;
    tracing::info!(addr = %config.http_addr, "worker health server listening");
    let health_router = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(state.clone());
    let health_server = tokio::spawn(async move {
        if let Err(err) = axum::serve(health_listener, health_router).await {
            tracing::warn!(error = %err, "worker health server stopped");
        }
    });

    let result = run_apalis_worker_until_shutdown(
        database_url,
        "mnt.dispatch",
        format!("{}-dispatch-worker", config.service_name),
        worker,
        shutdown_signal(config.shutdown_timeout, state.clone()),
    )
    .await
    .map_err(|err| AppError::Worker(err.to_string()));

    health_server.abort();
    result
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
        }
    }
}
