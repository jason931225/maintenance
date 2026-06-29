use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext, UserId};
use mnt_platform_auth::{JwtVerifier, PasskeyAuthenticationCredential, PasskeyService};
use mnt_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub const WORKFLOW_STUDIO_CATALOG_PATH: &str = "/api/v1/workflow-studio/catalog";
pub const WORKFLOW_STUDIO_DEFINITIONS_PATH: &str = "/api/v1/workflow-studio/definitions";
pub const WORKFLOW_STUDIO_DEFINITION_HISTORY_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/history";
pub const WORKFLOW_STUDIO_DEFINITION_SIMULATE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/simulate";
pub const WORKFLOW_STUDIO_DEFINITION_PUBLISH_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/publish";
pub const WORKFLOW_STUDIO_DEFINITION_PAUSE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/pause";
pub const WORKFLOW_STUDIO_DEFINITION_ROLLBACK_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/rollback";
pub const WORKFLOW_STUDIO_DEFINITION_CLONE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/clone";

const WORKFLOW_STUDIO_REQUESTS_TOTAL: &str = "workflow_studio_requests_total";

const ALLOWED_CONNECTORS: &[ConnectorDescriptor] = &[
    ConnectorDescriptor {
        connector_key: "internal.approvals",
        display_name: "승인센터",
        action_keys: &["request_approval", "notify_assignee"],
    },
    ConnectorDescriptor {
        connector_key: "internal.notifications",
        display_name: "알림",
        action_keys: &["send_badge", "send_push", "send_email_digest"],
    },
    ConnectorDescriptor {
        connector_key: "internal.mail",
        display_name: "업무 메일",
        action_keys: &["send_work_mail"],
    },
    ConnectorDescriptor {
        connector_key: "internal.audit",
        display_name: "감사 로그",
        action_keys: &["append_timeline_event"],
    },
];

const WORKFLOW_TEMPLATES: &[WorkflowTemplate] = &[
    WorkflowTemplate {
        template_key: "maintenance_completion_approval",
        display_name: "정비 완료 승인",
        object_type: "work_order",
        required_approval_line: true,
        required_payment_line: false,
    },
    WorkflowTemplate {
        template_key: "purchase_payment_approval",
        display_name: "구매·정산 승인",
        object_type: "purchase_request",
        required_approval_line: true,
        required_payment_line: true,
    },
    WorkflowTemplate {
        template_key: "asset_transfer_signoff",
        display_name: "자산 이전 승인",
        object_type: "asset_transfer",
        required_approval_line: true,
        required_payment_line: false,
    },
];

#[derive(Clone)]
pub struct WorkflowStudioState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
    passkey_step_up: Option<PasskeyService>,
}

impl WorkflowStudioState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            pool,
            jwt_verifier,
            passkey_step_up: None,
        }
    }

    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
    }
}

pub fn router(state: WorkflowStudioState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(WORKFLOW_STUDIO_CATALOG_PATH, get(get_catalog))
        .route(
            WORKFLOW_STUDIO_DEFINITIONS_PATH,
            get(list_definitions).post(create_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_HISTORY_PATH_TEMPLATE,
            get(list_definition_history),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_SIMULATE_PATH_TEMPLATE,
            post(simulate_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_PUBLISH_PATH_TEMPLATE,
            post(publish_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_PAUSE_PATH_TEMPLATE,
            post(pause_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_ROLLBACK_PATH_TEMPLATE,
            post(rollback_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_CLONE_PATH_TEMPLATE,
            post(clone_definition),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Serialize)]
struct WorkflowStudioCatalogResponse {
    connectors: Vec<ConnectorResponse>,
    templates: Vec<WorkflowTemplateResponse>,
}

#[derive(Debug, Clone, Copy)]
struct ConnectorDescriptor {
    connector_key: &'static str,
    display_name: &'static str,
    action_keys: &'static [&'static str],
}

#[derive(Debug, Serialize)]
struct ConnectorResponse {
    connector_key: String,
    display_name: String,
    action_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct WorkflowTemplate {
    template_key: &'static str,
    display_name: &'static str,
    object_type: &'static str,
    required_approval_line: bool,
    required_payment_line: bool,
}

#[derive(Debug, Serialize)]
struct WorkflowTemplateResponse {
    template_key: String,
    display_name: String,
    object_type: String,
    required_approval_line: bool,
    required_payment_line: bool,
}

#[derive(Debug, Serialize)]
struct WorkflowDefinitionListResponse {
    items: Vec<WorkflowDefinitionResponse>,
}

#[derive(Debug, Serialize)]
struct WorkflowDefinitionHistoryResponse {
    items: Vec<WorkflowDefinitionEventResponse>,
}

#[derive(Debug, Serialize, Clone)]
struct WorkflowDefinitionResponse {
    id: Uuid,
    workflow_key: String,
    display_name: String,
    object_type: String,
    status: String,
    latest_version: i32,
    active_version: Option<i32>,
    definition: Value,
    approval_line: Vec<Value>,
    payment_line: Vec<Value>,
    notification_rules: Vec<Value>,
    action_allowlist: Vec<Value>,
    required_approval_line: bool,
    required_payment_line: bool,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct WorkflowDefinitionEventResponse {
    id: Uuid,
    definition_id: Uuid,
    version: Option<i32>,
    status: String,
    action: String,
    actor_display_name: Option<String>,
    summary: String,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct CreateWorkflowDefinitionRequest {
    workflow_key: String,
    display_name: String,
    object_type: String,
    #[serde(default = "empty_object")]
    definition: Value,
    #[serde(default)]
    approval_line: Vec<Value>,
    #[serde(default)]
    payment_line: Vec<Value>,
    #[serde(default)]
    notification_rules: Vec<Value>,
    #[serde(default)]
    action_allowlist: Vec<Value>,
    #[serde(default)]
    required_approval_line: bool,
    #[serde(default)]
    required_payment_line: bool,
}

#[derive(Debug, Deserialize)]
struct WorkflowStepUpRequest {
    #[serde(default)]
    step_up: Option<WorkflowStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
struct RollbackWorkflowDefinitionRequest {
    target_version: i32,
    #[serde(default)]
    step_up: Option<WorkflowStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
struct CloneWorkflowDefinitionRequest {
    #[serde(default)]
    workflow_key: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    step_up: Option<WorkflowStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
struct SimulateWorkflowDefinitionRequest {
    #[serde(default)]
    definition: Option<Value>,
    #[serde(default)]
    approval_line: Option<Vec<Value>>,
    #[serde(default)]
    payment_line: Option<Vec<Value>>,
    #[serde(default)]
    notification_rules: Option<Vec<Value>>,
    #[serde(default)]
    action_allowlist: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
struct WorkflowStepUpAssertionRequest {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Serialize)]
struct WorkflowSimulationResponse {
    decision: String,
    findings: Vec<WorkflowSimulationFinding>,
}

#[derive(Debug, Serialize)]
struct WorkflowSimulationFinding {
    severity: String,
    code: String,
    message: String,
}

#[derive(Debug, Clone)]
struct WorkflowVersionRow {
    definition_id: Uuid,
    workflow_key: String,
    display_name: String,
    object_type: String,
    status: String,
    latest_version: i32,
    active_version: Option<i32>,
    definition: Value,
    approval_line: Vec<Value>,
    payment_line: Vec<Value>,
    notification_rules: Vec<Value>,
    action_allowlist: Vec<Value>,
    required_approval_line: bool,
    required_payment_line: bool,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

async fn get_catalog(
    Extension(principal): Extension<Principal>,
) -> Result<Json<WorkflowStudioCatalogResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    record_workflow_studio_request("catalog", "success");
    Ok(Json(WorkflowStudioCatalogResponse {
        connectors: ALLOWED_CONNECTORS
            .iter()
            .map(|connector| ConnectorResponse {
                connector_key: connector.connector_key.to_owned(),
                display_name: connector.display_name.to_owned(),
                action_keys: connector
                    .action_keys
                    .iter()
                    .map(|action| (*action).to_owned())
                    .collect(),
            })
            .collect(),
        templates: WORKFLOW_TEMPLATES
            .iter()
            .map(|template| WorkflowTemplateResponse {
                template_key: template.template_key.to_owned(),
                display_name: template.display_name.to_owned(),
                object_type: template.object_type.to_owned(),
                required_approval_line: template.required_approval_line,
                required_payment_line: template.required_payment_line,
            })
            .collect(),
    }))
}

async fn list_definitions(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<WorkflowDefinitionListResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let org = principal.org_id;
    let items = with_org_conn::<_, _, WorkflowStudioError>(&state.pool, org, |tx| {
        Box::pin(async move {
            let rows = sqlx::query(
                r#"
                SELECT
                    d.id,
                    d.workflow_key,
                    d.display_name,
                    d.object_type,
                    d.status,
                    d.latest_version,
                    d.active_version,
                    d.created_at,
                    d.updated_at,
                    COALESCE(v.definition, '{}'::jsonb) AS definition,
                    COALESCE(v.approval_line, '[]'::jsonb) AS approval_line,
                    COALESCE(v.payment_line, '[]'::jsonb) AS payment_line,
                    COALESCE(v.notification_rules, '[]'::jsonb) AS notification_rules,
                    COALESCE(v.action_allowlist, '[]'::jsonb) AS action_allowlist,
                    COALESCE(v.required_approval_line, false) AS required_approval_line,
                    COALESCE(v.required_payment_line, false) AS required_payment_line
                FROM workflow_definitions d
                LEFT JOIN workflow_definition_versions v
                    ON v.definition_id = d.id
                   AND v.org_id = d.org_id
                   AND v.version = d.latest_version
                ORDER BY d.updated_at DESC, d.display_name ASC
                "#,
            )
            .fetch_all(tx.as_mut())
            .await?;
            rows.into_iter().map(response_from_row).collect()
        })
    })
    .await?;
    record_workflow_studio_request("definitions", "success");
    Ok(Json(WorkflowDefinitionListResponse { items }))
}

async fn create_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateWorkflowDefinitionRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let draft = normalize_create_request(body)?;
    let definition_id = Uuid::new_v4();
    let actor = principal.user_id;
    let org = principal.org_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": definition_id,
        "workflow_key": draft.workflow_key,
        "status": "DRAFT",
        "latest_version": 1,
        "required_approval_line": draft.required_approval_line,
        "required_payment_line": draft.required_payment_line
    });
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.create_draft")?,
        "workflow_definition",
        definition_id.to_string(),
        trace,
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after));
    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                r#"
                INSERT INTO workflow_definitions (
                    id, org_id, workflow_key, display_name, object_type,
                    status, latest_version, active_version, created_by, updated_by
                ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', 1, NULL, $6, $6)
                RETURNING id, workflow_key, display_name, object_type, status,
                    latest_version, active_version, created_at, updated_at
                "#,
            )
            .bind(definition_id)
            .bind(*org.as_uuid())
            .bind(&draft.workflow_key)
            .bind(&draft.display_name)
            .bind(&draft.object_type)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;

            sqlx::query(
                r#"
                INSERT INTO workflow_definition_versions (
                    org_id, definition_id, version, status, definition,
                    approval_line, payment_line, notification_rules, action_allowlist,
                    required_approval_line, required_payment_line, created_by
                ) VALUES ($1, $2, 1, 'DRAFT', $3, $4, $5, $6, $7, $8, $9, $10)
                "#,
            )
            .bind(*org.as_uuid())
            .bind(definition_id)
            .bind(&draft.definition)
            .bind(Value::Array(draft.approval_line.clone()))
            .bind(Value::Array(draft.payment_line.clone()))
            .bind(Value::Array(draft.notification_rules.clone()))
            .bind(Value::Array(draft.action_allowlist.clone()))
            .bind(draft.required_approval_line)
            .bind(draft.required_payment_line)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id,
                    version: Some(1),
                    action: "workflow_definition.create_draft",
                    actor: Some(actor),
                    summary: "초안 생성",
                    before_snap: None,
                    after_snap: Some(json!({
                        "workflow_key": draft.workflow_key,
                        "version": 1,
                        "status": "DRAFT"
                    })),
                },
            )
            .await?;

            Ok(WorkflowDefinitionResponse {
                id: row.try_get("id")?,
                workflow_key: row.try_get("workflow_key")?,
                display_name: row.try_get("display_name")?,
                object_type: row.try_get("object_type")?,
                status: row.try_get("status")?,
                latest_version: row.try_get("latest_version")?,
                active_version: row.try_get("active_version")?,
                definition: draft.definition,
                approval_line: draft.approval_line,
                payment_line: draft.payment_line,
                notification_rules: draft.notification_rules,
                action_allowlist: draft.action_allowlist,
                required_approval_line: draft.required_approval_line,
                required_payment_line: draft.required_payment_line,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
    })
    .await?;
    record_workflow_studio_request("create_draft", "success");
    Ok(Json(response))
}

async fn list_definition_history(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkflowDefinitionHistoryResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let org = principal.org_id;
    let items = with_org_conn::<_, _, WorkflowStudioError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            ensure_definition_exists(tx, id).await?;
            let rows = sqlx::query(
                r#"
                SELECT
                    e.id,
                    e.definition_id,
                    e.version,
                    COALESCE(v.status, 'EVENT') AS status,
                    e.action,
                    u.display_name AS actor_display_name,
                    e.summary,
                    e.created_at
                FROM workflow_definition_events e
                LEFT JOIN users u ON u.id = e.actor_id
                LEFT JOIN workflow_definition_versions v
                    ON v.definition_id = e.definition_id
                   AND v.org_id = e.org_id
                   AND v.version = e.version
                WHERE e.definition_id = $1
                ORDER BY e.created_at DESC
                "#,
            )
            .bind(id)
            .fetch_all(tx.as_mut())
            .await?;
            rows.into_iter()
                .map(|row| {
                    Ok(WorkflowDefinitionEventResponse {
                        id: row.try_get("id")?,
                        definition_id: row.try_get("definition_id")?,
                        version: row.try_get("version")?,
                        status: row.try_get("status")?,
                        action: row.try_get("action")?,
                        actor_display_name: row.try_get("actor_display_name")?,
                        summary: row.try_get("summary")?,
                        created_at: row.try_get("created_at")?,
                    })
                })
                .collect()
        })
    })
    .await?;
    Ok(Json(WorkflowDefinitionHistoryResponse { items }))
}

async fn simulate_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<SimulateWorkflowDefinitionRequest>,
) -> Result<Json<WorkflowSimulationResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let org = principal.org_id;
    let result = with_org_conn::<_, _, WorkflowStudioError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let mut row = load_latest_version(tx, id, false).await?;
            if let Some(definition) = body.definition {
                row.definition = validate_definition_object(definition)?;
            }
            if let Some(approval_line) = body.approval_line {
                row.approval_line = approval_line;
            }
            if let Some(payment_line) = body.payment_line {
                row.payment_line = payment_line;
            }
            if let Some(notification_rules) = body.notification_rules {
                row.notification_rules = notification_rules;
            }
            if let Some(action_allowlist) = body.action_allowlist {
                validate_action_allowlist(&action_allowlist)?;
                row.action_allowlist = action_allowlist;
            }
            Ok(simulation_for(&row))
        })
    })
    .await?;
    record_workflow_studio_request("simulate", "success");
    Ok(Json(result))
}

async fn publish_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<WorkflowStepUpRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    mutate_definition(
        &state,
        principal,
        id,
        "workflow_definition.publish",
        "게시",
        |row| {
            let findings = validate_publishable(row);
            if findings.is_empty() {
                Ok((
                    "ACTIVE",
                    "PUBLISHED",
                    row.latest_version + 1,
                    row.active_version,
                ))
            } else {
                Err(WorkflowStudioError::validation(
                    findings
                        .into_iter()
                        .map(|finding| finding.message)
                        .collect::<Vec<_>>()
                        .join("; "),
                ))
            }
        },
    )
    .await
    .map(Json)
}

async fn pause_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<WorkflowStepUpRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    mutate_definition(
        &state,
        principal,
        id,
        "workflow_definition.pause",
        "일시정지",
        |row| {
            if row.status != "ACTIVE" {
                return Err(WorkflowStudioError::validation(
                    "only ACTIVE workflow definitions can be paused",
                ));
            }
            Ok((
                "PAUSED",
                "PAUSED",
                row.latest_version + 1,
                row.active_version,
            ))
        },
    )
    .await
    .map(Json)
}

async fn rollback_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<RollbackWorkflowDefinitionRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    if body.target_version < 1 {
        return Err(WorkflowStudioError::validation(
            "target_version must be 1 or greater",
        ));
    }
    let target_version = body.target_version;
    mutate_definition_with_source_version(
        &state,
        principal,
        id,
        target_version,
        "workflow_definition.rollback",
        "롤백",
    )
    .await
    .map(Json)
}

async fn clone_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<CloneWorkflowDefinitionRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    let actor = principal.user_id;
    let org = principal.org_id;
    let new_id = Uuid::new_v4();
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.clone")?,
        "workflow_definition",
        new_id.to_string(),
        trace,
        now,
    )
    .with_org(org)
    .with_snapshots(Some(json!({ "source_definition_id": id })), None);
    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let source = load_latest_version(tx, id, true).await?;
            let workflow_key = match body.workflow_key {
                Some(value) => normalize_workflow_key(&value)?,
                None => format!(
                    "{}_copy_{}",
                    source.workflow_key,
                    &new_id.simple().to_string()[..8]
                ),
            };
            let display_name = body
                .display_name
                .map(|value| normalize_display_name(&value))
                .transpose()?
                .unwrap_or_else(|| format!("{} 복제본", source.display_name));

            let row = sqlx::query(
                r#"
                INSERT INTO workflow_definitions (
                    id, org_id, workflow_key, display_name, object_type,
                    status, latest_version, active_version, created_by, updated_by
                ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', 1, NULL, $6, $6)
                RETURNING id, workflow_key, display_name, object_type, status,
                    latest_version, active_version, created_at, updated_at
                "#,
            )
            .bind(new_id)
            .bind(*org.as_uuid())
            .bind(&workflow_key)
            .bind(&display_name)
            .bind(&source.object_type)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;

            sqlx::query(
                r#"
                INSERT INTO workflow_definition_versions (
                    org_id, definition_id, version, status, definition,
                    approval_line, payment_line, notification_rules, action_allowlist,
                    required_approval_line, required_payment_line, created_by
                ) VALUES ($1, $2, 1, 'CLONED', $3, $4, $5, $6, $7, $8, $9, $10)
                "#,
            )
            .bind(*org.as_uuid())
            .bind(new_id)
            .bind(&source.definition)
            .bind(Value::Array(source.approval_line.clone()))
            .bind(Value::Array(source.payment_line.clone()))
            .bind(Value::Array(source.notification_rules.clone()))
            .bind(Value::Array(source.action_allowlist.clone()))
            .bind(source.required_approval_line)
            .bind(source.required_payment_line)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id: new_id,
                    version: Some(1),
                    action: "workflow_definition.clone",
                    actor: Some(actor),
                    summary: "복제본 생성",
                    before_snap: Some(json!({
                        "source_definition_id": id,
                        "source_version": source.latest_version
                    })),
                    after_snap: Some(json!({
                        "workflow_key": workflow_key,
                        "version": 1,
                        "status": "DRAFT"
                    })),
                },
            )
            .await?;

            Ok(WorkflowDefinitionResponse {
                id: row.try_get("id")?,
                workflow_key,
                display_name,
                object_type: row.try_get("object_type")?,
                status: row.try_get("status")?,
                latest_version: row.try_get("latest_version")?,
                active_version: row.try_get("active_version")?,
                definition: source.definition,
                approval_line: source.approval_line,
                payment_line: source.payment_line,
                notification_rules: source.notification_rules,
                action_allowlist: source.action_allowlist,
                required_approval_line: source.required_approval_line,
                required_payment_line: source.required_payment_line,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
    })
    .await?;
    record_workflow_studio_request("clone", "success");
    Ok(Json(response))
}

async fn mutate_definition<F>(
    state: &WorkflowStudioState,
    principal: Principal,
    definition_id: Uuid,
    audit_action: &'static str,
    summary: &'static str,
    transition: F,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError>
where
    F: FnOnce(
            &WorkflowVersionRow,
        )
            -> Result<(&'static str, &'static str, i32, Option<i32>), WorkflowStudioError>
        + Send
        + 'static,
{
    let actor = principal.user_id;
    let org = principal.org_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(audit_action)?,
        "workflow_definition",
        definition_id.to_string(),
        trace,
        now,
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, definition_id, true).await?;
            let before = snapshot_from_row(&current);
            let (definition_status, version_status, new_version, active_version_override) =
                transition(&current)?;
            let active_version = if definition_status == "ACTIVE" {
                Some(new_version)
            } else {
                active_version_override
            };

            let updated = insert_version_and_update_definition(
                tx,
                WorkflowVersionMutation {
                    org,
                    actor,
                    source: &current,
                    new_version,
                    version_status,
                    definition_status,
                    active_version,
                },
            )
            .await?;

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id,
                    version: Some(new_version),
                    action: audit_action,
                    actor: Some(actor),
                    summary,
                    before_snap: Some(before),
                    after_snap: Some(snapshot_from_response(&updated)),
                },
            )
            .await?;
            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request(audit_action, "success");
    Ok(response)
}

async fn mutate_definition_with_source_version(
    state: &WorkflowStudioState,
    principal: Principal,
    definition_id: Uuid,
    target_version: i32,
    audit_action: &'static str,
    summary: &'static str,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError> {
    let actor = principal.user_id;
    let org = principal.org_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(audit_action)?,
        "workflow_definition",
        definition_id.to_string(),
        trace,
        now,
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, definition_id, true).await?;
            let source = load_specific_version(tx, definition_id, target_version).await?;
            let before = snapshot_from_row(&current);
            let new_version = current.latest_version + 1;
            let source_for_insert = WorkflowVersionRow {
                latest_version: current.latest_version,
                status: current.status.clone(),
                active_version: current.active_version,
                created_at: current.created_at,
                updated_at: current.updated_at,
                ..source
            };
            let updated = insert_version_and_update_definition(
                tx,
                WorkflowVersionMutation {
                    org,
                    actor,
                    source: &source_for_insert,
                    new_version,
                    version_status: "ROLLED_BACK",
                    definition_status: "ACTIVE",
                    active_version: Some(new_version),
                },
            )
            .await?;

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id,
                    version: Some(new_version),
                    action: audit_action,
                    actor: Some(actor),
                    summary,
                    before_snap: Some(before),
                    after_snap: Some(json!({
                        "rolled_back_to": target_version,
                        "new_version": new_version,
                        "status": "ACTIVE"
                    })),
                },
            )
            .await?;
            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request(audit_action, "success");
    Ok(response)
}

struct WorkflowVersionMutation<'a> {
    org: mnt_kernel_core::OrgId,
    actor: UserId,
    source: &'a WorkflowVersionRow,
    new_version: i32,
    version_status: &'static str,
    definition_status: &'static str,
    active_version: Option<i32>,
}

async fn insert_version_and_update_definition(
    tx: &mut Transaction<'_, Postgres>,
    mutation: WorkflowVersionMutation<'_>,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError> {
    sqlx::query(
        r#"
        INSERT INTO workflow_definition_versions (
            org_id, definition_id, version, status, definition,
            approval_line, payment_line, notification_rules, action_allowlist,
            required_approval_line, required_payment_line, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        "#,
    )
    .bind(*mutation.org.as_uuid())
    .bind(mutation.source.definition_id)
    .bind(mutation.new_version)
    .bind(mutation.version_status)
    .bind(&mutation.source.definition)
    .bind(Value::Array(mutation.source.approval_line.clone()))
    .bind(Value::Array(mutation.source.payment_line.clone()))
    .bind(Value::Array(mutation.source.notification_rules.clone()))
    .bind(Value::Array(mutation.source.action_allowlist.clone()))
    .bind(mutation.source.required_approval_line)
    .bind(mutation.source.required_payment_line)
    .bind(*mutation.actor.as_uuid())
    .execute(tx.as_mut())
    .await?;

    let row = sqlx::query(
        r#"
        UPDATE workflow_definitions
           SET status = $2,
               latest_version = $3,
               active_version = $4,
               updated_by = $5,
               updated_at = now()
         WHERE id = $1
        RETURNING id, workflow_key, display_name, object_type, status,
            latest_version, active_version, created_at, updated_at
        "#,
    )
    .bind(mutation.source.definition_id)
    .bind(mutation.definition_status)
    .bind(mutation.new_version)
    .bind(mutation.active_version)
    .bind(*mutation.actor.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;

    Ok(WorkflowDefinitionResponse {
        id: row.try_get("id")?,
        workflow_key: row.try_get("workflow_key")?,
        display_name: row.try_get("display_name")?,
        object_type: row.try_get("object_type")?,
        status: row.try_get("status")?,
        latest_version: row.try_get("latest_version")?,
        active_version: row.try_get("active_version")?,
        definition: mutation.source.definition.clone(),
        approval_line: mutation.source.approval_line.clone(),
        payment_line: mutation.source.payment_line.clone(),
        notification_rules: mutation.source.notification_rules.clone(),
        action_allowlist: mutation.source.action_allowlist.clone(),
        required_approval_line: mutation.source.required_approval_line,
        required_payment_line: mutation.source.required_payment_line,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn load_latest_version(
    tx: &mut Transaction<'_, Postgres>,
    definition_id: Uuid,
    for_update: bool,
) -> Result<WorkflowVersionRow, WorkflowStudioError> {
    let row = if for_update {
        sqlx::query(
            r#"
            SELECT
                d.id,
                d.workflow_key,
                d.display_name,
                d.object_type,
                d.status,
                d.latest_version,
                d.active_version,
                d.created_at,
                d.updated_at,
                v.definition,
                v.approval_line,
                v.payment_line,
                v.notification_rules,
                v.action_allowlist,
                v.required_approval_line,
                v.required_payment_line
            FROM workflow_definitions d
            JOIN workflow_definition_versions v
              ON v.definition_id = d.id
             AND v.org_id = d.org_id
             AND v.version = d.latest_version
            WHERE d.id = $1
            FOR UPDATE OF d
            "#,
        )
        .bind(definition_id)
        .fetch_optional(tx.as_mut())
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT
                d.id,
                d.workflow_key,
                d.display_name,
                d.object_type,
                d.status,
                d.latest_version,
                d.active_version,
                d.created_at,
                d.updated_at,
                v.definition,
                v.approval_line,
                v.payment_line,
                v.notification_rules,
                v.action_allowlist,
                v.required_approval_line,
                v.required_payment_line
            FROM workflow_definitions d
            JOIN workflow_definition_versions v
              ON v.definition_id = d.id
             AND v.org_id = d.org_id
             AND v.version = d.latest_version
            WHERE d.id = $1
            "#,
        )
        .bind(definition_id)
        .fetch_optional(tx.as_mut())
        .await?
    }
    .ok_or_else(|| KernelError::not_found("workflow definition not found"))?;
    row_to_version(row)
}

async fn load_specific_version(
    tx: &mut Transaction<'_, Postgres>,
    definition_id: Uuid,
    version: i32,
) -> Result<WorkflowVersionRow, WorkflowStudioError> {
    let row = sqlx::query(
        r#"
        SELECT
            d.id,
            d.workflow_key,
            d.display_name,
            d.object_type,
            d.status,
            d.latest_version,
            d.active_version,
            d.created_at,
            d.updated_at,
            v.definition,
            v.approval_line,
            v.payment_line,
            v.notification_rules,
            v.action_allowlist,
            v.required_approval_line,
            v.required_payment_line
        FROM workflow_definitions d
        JOIN workflow_definition_versions v
          ON v.definition_id = d.id
         AND v.org_id = d.org_id
         AND v.version = $2
        WHERE d.id = $1
        "#,
    )
    .bind(definition_id)
    .bind(version)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("workflow definition version not found"))?;
    row_to_version(row)
}

async fn ensure_definition_exists(
    tx: &mut Transaction<'_, Postgres>,
    definition_id: Uuid,
) -> Result<(), WorkflowStudioError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workflow_definitions WHERE id = $1)",
    )
    .bind(definition_id)
    .fetch_one(tx.as_mut())
    .await?;
    if exists {
        Ok(())
    } else {
        Err(KernelError::not_found("workflow definition not found").into())
    }
}

struct WorkflowAuditEvent {
    org: mnt_kernel_core::OrgId,
    definition_id: Uuid,
    version: Option<i32>,
    action: &'static str,
    actor: Option<UserId>,
    summary: &'static str,
    before_snap: Option<Value>,
    after_snap: Option<Value>,
}

async fn insert_workflow_event(
    tx: &mut Transaction<'_, Postgres>,
    event: WorkflowAuditEvent,
) -> Result<(), WorkflowStudioError> {
    sqlx::query(
        r#"
        INSERT INTO workflow_definition_events (
            org_id, definition_id, version, action, actor_id,
            summary, before_snap, after_snap
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(*event.org.as_uuid())
    .bind(event.definition_id)
    .bind(event.version)
    .bind(event.action)
    .bind(event.actor.map(|user| *user.as_uuid()))
    .bind(event.summary)
    .bind(event.before_snap)
    .bind(event.after_snap)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn response_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError> {
    Ok(WorkflowDefinitionResponse {
        id: row.try_get("id")?,
        workflow_key: row.try_get("workflow_key")?,
        display_name: row.try_get("display_name")?,
        object_type: row.try_get("object_type")?,
        status: row.try_get("status")?,
        latest_version: row.try_get("latest_version")?,
        active_version: row.try_get("active_version")?,
        definition: row.try_get("definition")?,
        approval_line: json_array(row.try_get("approval_line")?),
        payment_line: json_array(row.try_get("payment_line")?),
        notification_rules: json_array(row.try_get("notification_rules")?),
        action_allowlist: json_array(row.try_get("action_allowlist")?),
        required_approval_line: row.try_get("required_approval_line")?,
        required_payment_line: row.try_get("required_payment_line")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_version(row: sqlx::postgres::PgRow) -> Result<WorkflowVersionRow, WorkflowStudioError> {
    Ok(WorkflowVersionRow {
        definition_id: row.try_get("id")?,
        workflow_key: row.try_get("workflow_key")?,
        display_name: row.try_get("display_name")?,
        object_type: row.try_get("object_type")?,
        status: row.try_get("status")?,
        latest_version: row.try_get("latest_version")?,
        active_version: row.try_get("active_version")?,
        definition: row.try_get("definition")?,
        approval_line: json_array(row.try_get("approval_line")?),
        payment_line: json_array(row.try_get("payment_line")?),
        notification_rules: json_array(row.try_get("notification_rules")?),
        action_allowlist: json_array(row.try_get("action_allowlist")?),
        required_approval_line: row.try_get("required_approval_line")?,
        required_payment_line: row.try_get("required_payment_line")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn normalize_create_request(
    body: CreateWorkflowDefinitionRequest,
) -> Result<CreateWorkflowDefinitionRequest, WorkflowStudioError> {
    let workflow_key = normalize_workflow_key(&body.workflow_key)?;
    let display_name = normalize_display_name(&body.display_name)?;
    let object_type = normalize_object_type(&body.object_type)?;
    let definition = validate_definition_object(body.definition)?;
    validate_action_allowlist(&body.action_allowlist)?;
    validate_notification_rules(&body.notification_rules)?;
    Ok(CreateWorkflowDefinitionRequest {
        workflow_key,
        display_name,
        object_type,
        definition,
        approval_line: body.approval_line,
        payment_line: body.payment_line,
        notification_rules: body.notification_rules,
        action_allowlist: body.action_allowlist,
        required_approval_line: body.required_approval_line,
        required_payment_line: body.required_payment_line,
    })
}

fn normalize_workflow_key(raw: &str) -> Result<String, WorkflowStudioError> {
    let value = raw.trim().to_ascii_lowercase();
    let valid = value.split('.').count() >= 2
        && value.split('.').all(|segment| {
            let mut chars = segment.chars();
            matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
                && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        });
    if valid && value.len() <= 160 {
        Ok(value)
    } else {
        Err(WorkflowStudioError::validation(
            "workflow_key must be dot-separated lowercase segments",
        ))
    }
}

fn normalize_object_type(raw: &str) -> Result<String, WorkflowStudioError> {
    let value = raw.trim().to_ascii_lowercase();
    let valid = value.len() >= 2
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        && value
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase());
    if valid {
        Ok(value)
    } else {
        Err(WorkflowStudioError::validation(
            "object_type must be lowercase snake_case",
        ))
    }
}

fn normalize_display_name(raw: &str) -> Result<String, WorkflowStudioError> {
    let value = raw.trim().to_owned();
    if (1..=120).contains(&value.chars().count()) {
        Ok(value)
    } else {
        Err(WorkflowStudioError::validation(
            "display_name must be 1 to 120 characters",
        ))
    }
}

fn validate_definition_object(value: Value) -> Result<Value, WorkflowStudioError> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(WorkflowStudioError::validation(
            "definition must be a JSON object",
        ))
    }
}

fn validate_action_allowlist(actions: &[Value]) -> Result<(), WorkflowStudioError> {
    for action in actions {
        let connector_key = action
            .get("connector_key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                WorkflowStudioError::validation("action_allowlist entries require connector_key")
            })?;
        let action_key = action
            .get("action_key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                WorkflowStudioError::validation("action_allowlist entries require action_key")
            })?;
        if !connector_allows(connector_key, action_key) {
            return Err(WorkflowStudioError::validation(format!(
                "action {connector_key}.{action_key} is not in the Workflow Studio connector allowlist"
            )));
        }
    }
    Ok(())
}

fn validate_notification_rules(rules: &[Value]) -> Result<(), WorkflowStudioError> {
    for rule in rules {
        if !rule.is_object() {
            return Err(WorkflowStudioError::validation(
                "notification_rules entries must be JSON objects",
            ));
        }
        if let Some(action_key) = rule.get("action_key").and_then(Value::as_str)
            && !connector_allows("internal.notifications", action_key)
            && !connector_allows("internal.mail", action_key)
        {
            return Err(WorkflowStudioError::validation(format!(
                "notification action {action_key} is not allowlisted"
            )));
        }
    }
    Ok(())
}

fn connector_allows(connector_key: &str, action_key: &str) -> bool {
    ALLOWED_CONNECTORS.iter().any(|connector| {
        connector.connector_key == connector_key && connector.action_keys.contains(&action_key)
    })
}

fn validate_publishable(row: &WorkflowVersionRow) -> Vec<WorkflowSimulationFinding> {
    let mut findings = Vec::new();
    if row.required_approval_line && row.approval_line.is_empty() {
        findings.push(WorkflowSimulationFinding {
            severity: "blocker".to_owned(),
            code: "missing_approval_line".to_owned(),
            message: "required approval line is empty".to_owned(),
        });
    }
    if row.required_payment_line && row.payment_line.is_empty() {
        findings.push(WorkflowSimulationFinding {
            severity: "blocker".to_owned(),
            code: "missing_payment_line".to_owned(),
            message: "required payment line is empty".to_owned(),
        });
    }
    if row.action_allowlist.is_empty() {
        findings.push(WorkflowSimulationFinding {
            severity: "warning".to_owned(),
            code: "empty_action_allowlist".to_owned(),
            message: "no connector actions are enabled".to_owned(),
        });
    }
    if let Err(error) = validate_action_allowlist(&row.action_allowlist) {
        findings.push(WorkflowSimulationFinding {
            severity: "blocker".to_owned(),
            code: "invalid_action_allowlist".to_owned(),
            message: error.message,
        });
    }
    if let Err(error) = validate_notification_rules(&row.notification_rules) {
        findings.push(WorkflowSimulationFinding {
            severity: "blocker".to_owned(),
            code: "invalid_notification_rules".to_owned(),
            message: error.message,
        });
    }
    findings
        .into_iter()
        .filter(|finding| finding.severity == "blocker")
        .collect()
}

fn simulation_for(row: &WorkflowVersionRow) -> WorkflowSimulationResponse {
    let findings = validate_publishable(row);
    let decision = if findings.iter().any(|finding| finding.severity == "blocker") {
        "blocked"
    } else {
        "ready"
    };
    WorkflowSimulationResponse {
        decision: decision.to_owned(),
        findings,
    }
}

async fn verify_workflow_step_up(
    state: &WorkflowStudioState,
    principal: &Principal,
    step_up: Option<WorkflowStepUpAssertionRequest>,
) -> Result<(), WorkflowStudioError> {
    let step_up = step_up.ok_or_else(|| {
        WorkflowStudioError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "passkey_step_up_required",
            "workflow publication changes require a fresh passkey step-up",
        )
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        WorkflowStudioError::unavailable("passkey step-up is not configured for Workflow Studio")
    })?;
    verifier
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|_| WorkflowStudioError::unauthorized("passkey step-up failed"))?;
    Ok(())
}

fn authorize_workflow_manage(principal: &Principal) -> Result<(), WorkflowStudioError> {
    authorize_org_wide(principal, Action::new(Feature::RoleManage))
        .map_err(WorkflowStudioError::from)
}

fn snapshot_from_row(row: &WorkflowVersionRow) -> Value {
    json!({
        "id": row.definition_id,
        "workflow_key": row.workflow_key,
        "status": row.status,
        "latest_version": row.latest_version,
        "active_version": row.active_version,
        "required_approval_line": row.required_approval_line,
        "required_payment_line": row.required_payment_line
    })
}

fn snapshot_from_response(row: &WorkflowDefinitionResponse) -> Value {
    json!({
        "id": row.id,
        "workflow_key": row.workflow_key,
        "status": row.status,
        "latest_version": row.latest_version,
        "active_version": row.active_version,
        "required_approval_line": row.required_approval_line,
        "required_payment_line": row.required_payment_line
    })
}

fn json_array(value: Value) -> Vec<Value> {
    match value {
        Value::Array(values) => values,
        _ => Vec::new(),
    }
}

fn empty_object() -> Value {
    json!({})
}

fn record_workflow_studio_request(surface: &'static str, outcome: &'static str) {
    metrics::counter!(
        WORKFLOW_STUDIO_REQUESTS_TOTAL,
        "surface" => surface,
        "outcome" => outcome,
    )
    .increment(1);
}

#[derive(Debug)]
struct WorkflowStudioError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl WorkflowStudioError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::from(KernelError::validation(message.into()))
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl From<KernelError> for WorkflowStudioError {
    fn from(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code: error_code(error.kind),
            message: error.message,
        }
    }
}

impl From<DbError> for WorkflowStudioError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "workflow studio database operation failed");
        Self::internal("workflow studio request failed")
    }
}

impl From<sqlx::Error> for WorkflowStudioError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for WorkflowStudioError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

fn error_code(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_rejects_unknown_connector_actions() -> Result<(), String> {
        let err = match validate_action_allowlist(&[json!({
            "connector_key": "external.random",
            "action_key": "post_secret"
        })]) {
            Ok(()) => return Err("unknown connector must fail closed".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            err.message
                .contains("not in the Workflow Studio connector allowlist")
        );
        Ok(())
    }

    #[test]
    fn required_lines_block_publish() {
        let row = WorkflowVersionRow {
            definition_id: Uuid::new_v4(),
            workflow_key: "work_order.completion".to_owned(),
            display_name: "Completion".to_owned(),
            object_type: "work_order".to_owned(),
            status: "DRAFT".to_owned(),
            latest_version: 1,
            active_version: None,
            definition: json!({}),
            approval_line: vec![],
            payment_line: vec![],
            notification_rules: vec![],
            action_allowlist: vec![json!({
                "connector_key": "internal.approvals",
                "action_key": "request_approval"
            })],
            required_approval_line: true,
            required_payment_line: true,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        };

        let findings = validate_publishable(&row);
        assert!(
            findings
                .iter()
                .any(|finding| finding.code == "missing_approval_line")
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.code == "missing_payment_line")
        );
    }
}
