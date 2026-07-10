use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext, UserId};
use mnt_platform_auth::{JwtVerifier, PasskeyAuthenticationCredential, PasskeyService};
use mnt_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use time::OffsetDateTime;
use uuid::Uuid;

pub const WORKFLOW_STUDIO_CATALOG_PATH: &str = "/api/v1/workflow-studio/catalog";
pub const WORKFLOW_STUDIO_DEFINITIONS_PATH: &str = "/api/v1/workflow-studio/definitions";
pub const WORKFLOW_STUDIO_DEFINITION_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}";
pub const WORKFLOW_STUDIO_DEFINITION_HISTORY_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/history";
pub const WORKFLOW_STUDIO_DEFINITION_RUN_LOG_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/run-log";
pub const WORKFLOW_STUDIO_DEFINITION_RUN_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/run";
pub const WORKFLOW_STUDIO_DEFINITION_SIMULATE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/simulate";
pub const WORKFLOW_STUDIO_DEFINITION_PUBLISH_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/publish";
pub const WORKFLOW_STUDIO_DEFINITION_APPROVE_REVISION_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/approve";
pub const WORKFLOW_STUDIO_DEFINITION_WITHDRAW_REVISION_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/withdraw";
pub const WORKFLOW_STUDIO_DEFINITION_PAUSE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/pause";
pub const WORKFLOW_STUDIO_DEFINITION_RESUME_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/resume";
pub const WORKFLOW_STUDIO_DEFINITION_ROLLBACK_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/rollback";
pub const WORKFLOW_STUDIO_DEFINITION_CLONE_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}/clone";
pub const WORKFLOW_STUDIO_ROUTE_PATHS: &[&str] = &[
    WORKFLOW_STUDIO_CATALOG_PATH,
    WORKFLOW_STUDIO_DEFINITIONS_PATH,
    WORKFLOW_STUDIO_DEFINITION_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_HISTORY_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_RUN_LOG_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_RUN_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_SIMULATE_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_PUBLISH_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_APPROVE_REVISION_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_WITHDRAW_REVISION_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_PAUSE_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_RESUME_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_ROLLBACK_PATH_TEMPLATE,
    WORKFLOW_STUDIO_DEFINITION_CLONE_PATH_TEMPLATE,
];

const WORKFLOW_STUDIO_REQUESTS_TOTAL: &str = "workflow_studio_requests_total";
const WORKFLOW_DEFINITION_SCHEMA_VERSION: &str = "workflow.definition.v1";
/// Bumped schema version for an *executable* definition: a run/node graph the M2
/// workflow runtime interprets (design §3 closes "definition JSONB has no node
/// graph"). `workflow.definition.v1` stays the authoring/policy schema; `wf.exec.v1`
/// additionally carries a `nodes` graph the runtime walks.
const WORKFLOW_EXEC_SCHEMA_VERSION: &str = "wf.exec.v1";
const POLICY_TEMPLATE_EQUIPMENT_LOCATION_ACCESS: &str = "equipment_location_access";
const POLICY_ACTION_START_WORK_ORDER: &str = "maintenance:StartWorkOrder";

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
    // JOB channel (design §E / M2 runtime): the transactional-outbox connector the
    // completion→approval→payroll template fans out through. `emit_payroll` enqueues
    // one `JOB` outbox event via this connector; publish-validation rejects the
    // template's action_allowlist entry `internal.jobs.draft_payroll_run` unless this
    // descriptor is allowlisted (see `maintenance_completion_execution_definition`).
    ConnectorDescriptor {
        connector_key: "internal.jobs",
        display_name: "백그라운드 잡",
        action_keys: &["draft_payroll_run"],
    },
];

const WORKFLOW_TEMPLATES: &[WorkflowTemplate] = &[
    WorkflowTemplate {
        template_key: "equipment_location_access_policy",
        display_name: "장비·위치 접근 정책",
        object_type: "equipment",
        required_approval_line: true,
        required_payment_line: false,
    },
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
            WORKFLOW_STUDIO_DEFINITION_PATH_TEMPLATE,
            patch(update_definition).delete(archive_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_HISTORY_PATH_TEMPLATE,
            get(list_definition_history),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_RUN_LOG_PATH_TEMPLATE,
            get(list_definition_run_log),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_RUN_PATH_TEMPLATE,
            post(trigger_definition_run),
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
            WORKFLOW_STUDIO_DEFINITION_APPROVE_REVISION_PATH_TEMPLATE,
            post(approve_revision),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_WITHDRAW_REVISION_PATH_TEMPLATE,
            post(withdraw_revision),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_PAUSE_PATH_TEMPLATE,
            post(pause_definition),
        )
        .route(
            WORKFLOW_STUDIO_DEFINITION_RESUME_PATH_TEMPLATE,
            post(resume_definition),
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

#[derive(Debug, Serialize)]
struct WorkflowRunLogResponse {
    items: Vec<WorkflowRunResponse>,
}

#[derive(Debug, Serialize)]
struct WorkflowRunResponse {
    id: Uuid,
    code: String,
    definition_id: Uuid,
    definition_version: i32,
    trigger_type: String,
    status: String,
    actor_display_name: Option<String>,
    summary: String,
    error_message: Option<String>,
    generated_objects: Vec<String>,
    #[serde(with = "time::serde::rfc3339")]
    started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    completed_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    failed_at: Option<OffsetDateTime>,
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
    pending_version: Option<i32>,
    pending_staged_by: Option<Uuid>,
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
struct TriggerWorkflowRunRequest {
    #[serde(default = "default_workflow_run_trigger_type")]
    trigger_type: String,
    #[serde(default)]
    idempotency_key: Option<String>,
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
struct UpdateWorkflowDefinitionRequest {
    #[serde(default)]
    display_name: Option<String>,
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
    #[serde(default)]
    required_approval_line: Option<bool>,
    #[serde(default)]
    required_payment_line: Option<bool>,
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
    pending_version: Option<i32>,
    pending_staged_by: Option<Uuid>,
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
                WHERE d.status <> 'RETIRED'
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
                pending_version: None,
                pending_staged_by: None,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
    })
    .await?;
    record_workflow_studio_request("create_draft", "success");
    Ok(Json(response))
}

async fn update_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateWorkflowDefinitionRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let update = normalize_update_request(body)?;
    let actor = principal.user_id;
    let org = principal.org_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.update_draft")?,
        "workflow_definition",
        id.to_string(),
        trace,
        now,
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, id, true).await?;
            let before = snapshot_from_row(&current);
            let next = apply_draft_update(&current, update)?;
            let new_version = current.latest_version + 1;
            let definition_status = keep_live_status(&current);
            let updated = insert_version_and_update_definition(
                tx,
                WorkflowVersionMutation {
                    org,
                    actor,
                    source: &next,
                    new_version,
                    version_status: "DRAFT",
                    definition_status,
                    active_version: current.active_version,
                },
            )
            .await?;

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id: id,
                    version: Some(new_version),
                    action: "workflow_definition.update_draft",
                    actor: Some(actor),
                    summary: "초안 편집",
                    before_snap: Some(before),
                    after_snap: Some(snapshot_from_response(&updated)),
                },
            )
            .await?;

            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request("update_draft", "success");
    Ok(Json(response))
}

async fn archive_definition(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<WorkflowStepUpRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    let actor = principal.user_id;
    let org = principal.org_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.archive_draft")?,
        "workflow_definition",
        id.to_string(),
        trace,
        now,
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, id, true).await?;
            ensure_draft_definition(&current, "archived")?;
            let before = snapshot_from_row(&current);
            let row = sqlx::query(
                r#"
                UPDATE workflow_definitions
                   SET status = 'RETIRED',
                       updated_by = $2,
                       updated_at = now()
                 WHERE id = $1
                RETURNING id, workflow_key, display_name, object_type, status,
                    latest_version, active_version, created_at, updated_at
                "#,
            )
            .bind(id)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;

            let updated = WorkflowDefinitionResponse {
                id: row.try_get("id")?,
                workflow_key: row.try_get("workflow_key")?,
                display_name: row.try_get("display_name")?,
                object_type: row.try_get("object_type")?,
                status: row.try_get("status")?,
                latest_version: row.try_get("latest_version")?,
                active_version: row.try_get("active_version")?,
                definition: current.definition.clone(),
                approval_line: current.approval_line.clone(),
                payment_line: current.payment_line.clone(),
                notification_rules: current.notification_rules.clone(),
                action_allowlist: current.action_allowlist.clone(),
                required_approval_line: current.required_approval_line,
                required_payment_line: current.required_payment_line,
                pending_version: current.pending_version,
                pending_staged_by: current.pending_staged_by,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            };

            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id: id,
                    version: Some(current.latest_version),
                    action: "workflow_definition.archive_draft",
                    actor: Some(actor),
                    summary: "초안 삭제",
                    before_snap: Some(before),
                    after_snap: Some(snapshot_from_response(&updated)),
                },
            )
            .await?;

            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request("archive_draft", "success");
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

async fn list_definition_run_log(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<WorkflowRunLogResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let org = principal.org_id;
    let items = with_org_conn::<_, _, WorkflowStudioError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            ensure_definition_exists(tx, id).await?;
            let rows = sqlx::query(workflow_run_log_sql())
                .bind(id)
                .fetch_all(tx.as_mut())
                .await?;
            rows.into_iter().map(run_response_from_row).collect()
        })
    })
    .await?;
    record_workflow_studio_request("run_log", "success");
    Ok(Json(WorkflowRunLogResponse { items }))
}

async fn trigger_definition_run(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<TriggerWorkflowRunRequest>,
) -> Result<Json<WorkflowRunResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let trigger_type = normalize_workflow_run_trigger_type(&body.trigger_type)?;
    let run_id = Uuid::new_v4();
    let actor = principal.user_id;
    let org = principal.org_id;
    let idempotency_key =
        normalize_workflow_run_idempotency_key(body.idempotency_key, id, &trigger_type, run_id)?;
    let trace = TraceContext::generate();
    let trace_id = trace.trace_id().to_owned();
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_run.trigger")?,
        "workflow_run",
        run_id.to_string(),
        trace,
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "definition_id": id,
            "trigger_type": &trigger_type,
            "status": "RUNNING"
        })),
    );

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, id, false).await?;
            let Some(active_version) = current.active_version else {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "workflow definition must be active before it can run",
                )));
            };
            if current.status != "ACTIVE" {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "workflow definition must be active before it can run",
                )));
            }
            if let Some(existing) = load_run_by_idempotency_key(tx, &idempotency_key).await? {
                return Ok(existing);
            }

            let row = sqlx::query(
                r#"
                WITH inserted AS (
                    INSERT INTO workflow_runs (
                        id, org_id, definition_id, definition_version, status,
                        trigger_type, idempotency_key, correlation_id, trace_id,
                        input_payload, context_payload, initiated_by
                    ) VALUES (
                        $1, $2, $3, $4, 'RUNNING', $5, $6, $7, $8, $9, $10, $11
                    )
                    RETURNING id, definition_id, definition_version, trigger_type, status,
                        initiated_by, output_payload, error_payload, started_at, updated_at,
                        completed_at, failed_at
                )
                SELECT
                    i.id,
                    concat('RUN-', upper(substr(replace(i.id::text, '-', ''), 1, 6))) AS code,
                    i.definition_id,
                    i.definition_version,
                    i.trigger_type,
                    i.status,
                    u.display_name AS actor_display_name,
                    CASE i.trigger_type
                        WHEN 'SCHEDULE' THEN '예약 실행 시작'
                        ELSE '수동 실행 시작'
                    END AS summary,
                    COALESCE(i.error_payload->>'message', i.error_payload->>'error') AS error_message,
                    COALESCE(i.output_payload->'generated_objects', '[]'::jsonb) AS generated_objects,
                    i.started_at,
                    i.updated_at,
                    i.completed_at,
                    i.failed_at
                FROM inserted i
                LEFT JOIN users u ON u.id = i.initiated_by
                "#,
            )
            .bind(run_id)
            .bind(*org.as_uuid())
            .bind(id)
            .bind(active_version)
            .bind(&trigger_type)
            .bind(&idempotency_key)
            .bind(format!("workflow-studio:{run_id}"))
            .bind(trace_id)
            .bind(json!({ "trigger_type": trigger_type, "source": "workflow_studio" }))
            .bind(json!({
                "workflow_key": current.workflow_key,
                "display_name": current.display_name,
                "object_type": current.object_type
            }))
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
            run_response_from_row(row)
        })
    })
    .await?;
    record_workflow_studio_request("trigger_run", "success");
    Ok(Json(response))
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
                row.definition = validate_definition_for_object_type(definition, &row.object_type)?;
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
    let actor = principal.user_id;
    let org = principal.org_id;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.publish")?,
        "workflow_definition",
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);

    let (response, staged) =
        with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
            Box::pin(async move {
                let current = load_latest_version(tx, id, true).await?;
                ensure_not_retired(&current)?;
                let findings = validate_publishable(&current);
                if !findings.is_empty() {
                    return Err(WorkflowStudioError::validation(format_publish_findings(
                        findings,
                    )));
                }
                let before = snapshot_from_row(&current);

                if current.active_version.is_none() {
                    let new_version = current.latest_version + 1;
                    let updated = insert_version_and_update_definition(
                        tx,
                        WorkflowVersionMutation {
                            org,
                            actor,
                            source: &current,
                            new_version,
                            version_status: "PUBLISHED",
                            definition_status: "ACTIVE",
                            active_version: Some(new_version),
                        },
                    )
                    .await?;
                    insert_workflow_event(
                        tx,
                        WorkflowAuditEvent {
                            org,
                            definition_id: id,
                            version: Some(new_version),
                            action: "workflow_definition.publish",
                            actor: Some(actor),
                            summary: "게시",
                            before_snap: Some(before),
                            after_snap: Some(snapshot_from_response(&updated)),
                        },
                    )
                    .await?;
                    return Ok((updated, false));
                }

                if current.pending_version.is_some() {
                    return Err(WorkflowStudioError::from(KernelError::conflict(
                        "a revision is already pending approval; approve or withdraw it first",
                    )));
                }
                if current.latest_version == current.active_version.unwrap_or_default() {
                    return Err(WorkflowStudioError::from(KernelError::conflict(
                        "no draft revision to publish; edit the definition first",
                    )));
                }

                let pending_version = current.latest_version;
                let updated = stage_pending_revision(tx, id, pending_version, actor).await?;
                insert_workflow_event(
                    tx,
                    WorkflowAuditEvent {
                        org,
                        definition_id: id,
                        version: Some(pending_version),
                        action: "workflow_definition.stage_revision",
                        actor: Some(actor),
                        summary: "개정 상신(적용 대기)",
                        before_snap: Some(before),
                        after_snap: Some(snapshot_from_response(&updated)),
                    },
                )
                .await?;
                Ok((updated, true))
            })
        })
        .await?;
    record_workflow_studio_request(if staged { "stage_revision" } else { "publish" }, "success");
    Ok(Json(response))
}

async fn stage_pending_revision(
    tx: &mut Transaction<'_, Postgres>,
    definition_id: Uuid,
    pending_version: i32,
    actor: UserId,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError> {
    let row = sqlx::query(
        r#"
        UPDATE workflow_definitions
           SET pending_version = $2,
               pending_staged_by = $3,
               updated_by = $3,
               updated_at = now()
         WHERE id = $1
        RETURNING id, workflow_key, display_name, object_type, status,
            latest_version, active_version, pending_version, pending_staged_by,
            created_at, updated_at
        "#,
    )
    .bind(definition_id)
    .bind(pending_version)
    .bind(*actor.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    let staged = load_specific_version(tx, definition_id, pending_version).await?;
    definition_response(&row, &staged)
}

fn definition_response(
    row: &sqlx::postgres::PgRow,
    version: &WorkflowVersionRow,
) -> Result<WorkflowDefinitionResponse, WorkflowStudioError> {
    Ok(WorkflowDefinitionResponse {
        id: row.try_get("id")?,
        workflow_key: row.try_get("workflow_key")?,
        display_name: row.try_get("display_name")?,
        object_type: row.try_get("object_type")?,
        status: row.try_get("status")?,
        latest_version: row.try_get("latest_version")?,
        active_version: row.try_get("active_version")?,
        definition: version.definition.clone(),
        approval_line: version.approval_line.clone(),
        payment_line: version.payment_line.clone(),
        notification_rules: version.notification_rules.clone(),
        action_allowlist: version.action_allowlist.clone(),
        required_approval_line: version.required_approval_line,
        required_payment_line: version.required_payment_line,
        pending_version: row.try_get("pending_version")?,
        pending_staged_by: row.try_get("pending_staged_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn approve_revision(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path((id, rev)): Path<(Uuid, i32)>,
    Json(body): Json<WorkflowStepUpRequest>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    verify_workflow_step_up(&state, &principal, body.step_up).await?;
    let actor = principal.user_id;
    let org = principal.org_id;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.approve_revision")?,
        "workflow_definition",
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, id, true).await?;
            let Some(pending) = current.pending_version else {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "no revision is pending approval",
                )));
            };
            if pending != rev {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "the pending revision does not match the requested version",
                )));
            }
            if current.pending_staged_by == Some(*actor.as_uuid()) {
                return Err(WorkflowStudioError::from(KernelError::forbidden(
                    "본인이 상신한 개정은 승인할 수 없습니다",
                )));
            }

            let before = snapshot_from_row(&current);
            let source = load_specific_version(tx, id, pending).await?;
            let new_version = current.latest_version + 1;
            let source_for_insert = WorkflowVersionRow {
                latest_version: current.latest_version,
                status: current.status.clone(),
                active_version: current.active_version,
                pending_version: None,
                pending_staged_by: None,
                created_at: current.created_at,
                updated_at: current.updated_at,
                ..source
            };
            let updated = insert_version_and_clear_pending(
                tx,
                WorkflowVersionMutation {
                    org,
                    actor,
                    source: &source_for_insert,
                    new_version,
                    version_status: "PUBLISHED",
                    definition_status: "ACTIVE",
                    active_version: Some(new_version),
                },
            )
            .await?;
            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id: id,
                    version: Some(new_version),
                    action: "workflow_definition.approve_revision",
                    actor: Some(actor),
                    summary: "개정 적용 승인(four-eyes)",
                    before_snap: Some(before),
                    after_snap: Some(snapshot_from_response(&updated)),
                },
            )
            .await?;
            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request("approve_revision", "success");
    Ok(Json(response))
}

async fn withdraw_revision(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path((id, rev)): Path<(Uuid, i32)>,
) -> Result<Json<WorkflowDefinitionResponse>, WorkflowStudioError> {
    authorize_workflow_manage(&principal)?;
    let actor = principal.user_id;
    let org = principal.org_id;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_definition.withdraw_revision")?,
        "workflow_definition",
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org);

    let response = with_audit::<_, _, WorkflowStudioError>(&state.pool, event, move |tx| {
        Box::pin(async move {
            let current = load_latest_version(tx, id, true).await?;
            let Some(pending) = current.pending_version else {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "no revision is pending approval",
                )));
            };
            if pending != rev {
                return Err(WorkflowStudioError::from(KernelError::conflict(
                    "the pending revision does not match the requested version",
                )));
            }
            let before = snapshot_from_row(&current);
            let row = sqlx::query(
                r#"
                UPDATE workflow_definitions
                   SET pending_version = NULL,
                       pending_staged_by = NULL,
                       updated_by = $2,
                       updated_at = now()
                 WHERE id = $1
                RETURNING id, workflow_key, display_name, object_type, status,
                    latest_version, active_version, pending_version, pending_staged_by,
                    created_at, updated_at
                "#,
            )
            .bind(id)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
            let updated = definition_response(&row, &current)?;
            insert_workflow_event(
                tx,
                WorkflowAuditEvent {
                    org,
                    definition_id: id,
                    version: Some(pending),
                    action: "workflow_definition.withdraw_revision",
                    actor: Some(actor),
                    summary: "개정 철회",
                    before_snap: Some(before),
                    after_snap: Some(snapshot_from_response(&updated)),
                },
            )
            .await?;
            Ok(updated)
        })
    })
    .await?;
    record_workflow_studio_request("withdraw_revision", "success");
    Ok(Json(response))
}

async fn insert_version_and_clear_pending(
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
               pending_version = NULL,
               pending_staged_by = NULL,
               updated_by = $5,
               updated_at = now()
         WHERE id = $1
        RETURNING id, workflow_key, display_name, object_type, status,
            latest_version, active_version, pending_version, pending_staged_by,
            created_at, updated_at
        "#,
    )
    .bind(mutation.source.definition_id)
    .bind(mutation.definition_status)
    .bind(mutation.new_version)
    .bind(mutation.active_version)
    .bind(*mutation.actor.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    definition_response(&row, mutation.source)
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

async fn resume_definition(
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
        "workflow_definition.resume",
        "재개",
        |row| {
            if row.status != "PAUSED" {
                return Err(WorkflowStudioError::validation(
                    "only PAUSED workflow definitions can be resumed",
                ));
            }
            Ok((
                "ACTIVE",
                "RESUMED",
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
            ensure_not_retired(&source)?;
            validate_definition_for_object_type(source.definition.clone(), &source.object_type)?;
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
                pending_version: None,
                pending_staged_by: None,
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
            ensure_not_retired(&current)?;
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
            ensure_not_retired(&current)?;
            let source = load_specific_version(tx, definition_id, target_version).await?;
            validate_definition_for_object_type(source.definition.clone(), &source.object_type)?;
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
           SET display_name = $2,
               status = $3,
               latest_version = $4,
               active_version = $5,
               updated_by = $6,
               updated_at = now()
         WHERE id = $1
        RETURNING id, workflow_key, display_name, object_type, status,
            latest_version, active_version, pending_version, pending_staged_by,
            created_at, updated_at
        "#,
    )
    .bind(mutation.source.definition_id)
    .bind(&mutation.source.display_name)
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
        pending_version: row.try_get("pending_version")?,
        pending_staged_by: row.try_get("pending_staged_by")?,
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
                d.pending_version,
                d.pending_staged_by,
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
                d.pending_version,
                d.pending_staged_by,
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
            d.pending_version,
            d.pending_staged_by,
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
        pending_version: row.try_get("pending_version")?,
        pending_staged_by: row.try_get("pending_staged_by")?,
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
        pending_version: row.try_get("pending_version")?,
        pending_staged_by: row.try_get("pending_staged_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn run_response_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<WorkflowRunResponse, WorkflowStudioError> {
    Ok(WorkflowRunResponse {
        id: row.try_get("id")?,
        code: row.try_get("code")?,
        definition_id: row.try_get("definition_id")?,
        definition_version: row.try_get("definition_version")?,
        trigger_type: row.try_get("trigger_type")?,
        status: row.try_get("status")?,
        actor_display_name: row.try_get("actor_display_name")?,
        summary: row.try_get("summary")?,
        error_message: row.try_get("error_message")?,
        generated_objects: json_string_array(row.try_get("generated_objects")?),
        started_at: row.try_get("started_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
        failed_at: row.try_get("failed_at")?,
    })
}

async fn load_run_by_idempotency_key(
    tx: &mut Transaction<'_, Postgres>,
    idempotency_key: &str,
) -> Result<Option<WorkflowRunResponse>, WorkflowStudioError> {
    sqlx::query(workflow_run_by_idempotency_key_sql())
        .bind(idempotency_key)
        .fetch_optional(tx.as_mut())
        .await?
        .map(run_response_from_row)
        .transpose()
}

fn workflow_run_log_sql() -> &'static str {
    r#"
    SELECT
        r.id,
        concat('RUN-', upper(substr(replace(r.id::text, '-', ''), 1, 6))) AS code,
        r.definition_id,
        r.definition_version,
        r.trigger_type,
        r.status,
        u.display_name AS actor_display_name,
        CASE r.status
            WHEN 'SUCCEEDED' THEN '실행 완료'
            WHEN 'FAILED' THEN '실행 실패'
            WHEN 'CANCELLED' THEN '실행 취소'
            WHEN 'WAITING' THEN '승인/작업 대기'
            ELSE CASE r.trigger_type
                WHEN 'SCHEDULE' THEN '예약 실행 시작'
                ELSE '수동 실행 시작'
            END
        END AS summary,
        COALESCE(r.error_payload->>'message', r.error_payload->>'error') AS error_message,
        COALESCE(r.output_payload->'generated_objects', '[]'::jsonb) AS generated_objects,
        r.started_at,
        r.updated_at,
        r.completed_at,
        r.failed_at
    FROM workflow_runs r
    LEFT JOIN users u ON u.id = r.initiated_by
    WHERE r.definition_id = $1
    ORDER BY COALESCE(r.completed_at, r.failed_at, r.updated_at, r.started_at) DESC, r.id DESC
    LIMIT 25
    "#
}

fn workflow_run_by_idempotency_key_sql() -> &'static str {
    r#"
    SELECT
        r.id,
        concat('RUN-', upper(substr(replace(r.id::text, '-', ''), 1, 6))) AS code,
        r.definition_id,
        r.definition_version,
        r.trigger_type,
        r.status,
        u.display_name AS actor_display_name,
        CASE r.status
            WHEN 'SUCCEEDED' THEN '실행 완료'
            WHEN 'FAILED' THEN '실행 실패'
            WHEN 'CANCELLED' THEN '실행 취소'
            WHEN 'WAITING' THEN '승인/작업 대기'
            ELSE CASE r.trigger_type
                WHEN 'SCHEDULE' THEN '예약 실행 시작'
                ELSE '수동 실행 시작'
            END
        END AS summary,
        COALESCE(r.error_payload->>'message', r.error_payload->>'error') AS error_message,
        COALESCE(r.output_payload->'generated_objects', '[]'::jsonb) AS generated_objects,
        r.started_at,
        r.updated_at,
        r.completed_at,
        r.failed_at
    FROM workflow_runs r
    LEFT JOIN users u ON u.id = r.initiated_by
    WHERE r.idempotency_key = $1
    LIMIT 1
    "#
}

fn default_workflow_run_trigger_type() -> String {
    "MANUAL".to_owned()
}

fn normalize_workflow_run_trigger_type(value: &str) -> Result<String, WorkflowStudioError> {
    let normalized = value.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "MANUAL" | "SCHEDULE" | "WEBHOOK" | "SYSTEM" => Ok(normalized),
        _ => Err(WorkflowStudioError::validation(
            "workflow run trigger_type must be MANUAL, SCHEDULE, WEBHOOK, or SYSTEM",
        )),
    }
}

fn normalize_workflow_run_idempotency_key(
    value: Option<String>,
    definition_id: Uuid,
    trigger_type: &str,
    run_id: Uuid,
) -> Result<String, WorkflowStudioError> {
    match value {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.len() > 160 {
                return Err(WorkflowStudioError::validation(
                    "workflow run idempotency_key must be 1..160 characters",
                ));
            }
            Ok(trimmed.to_owned())
        }
        None => Ok(format!(
            "workflow-studio:{definition_id}:{trigger_type}:{}",
            run_id.simple()
        )),
    }
}

fn normalize_create_request(
    body: CreateWorkflowDefinitionRequest,
) -> Result<CreateWorkflowDefinitionRequest, WorkflowStudioError> {
    let workflow_key = normalize_workflow_key(&body.workflow_key)?;
    let display_name = normalize_display_name(&body.display_name)?;
    let object_type = normalize_object_type(&body.object_type)?;
    let definition = validate_definition_for_object_type(body.definition, &object_type)?;
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

struct NormalizedWorkflowDefinitionUpdate {
    display_name: Option<String>,
    definition: Option<Value>,
    approval_line: Option<Vec<Value>>,
    payment_line: Option<Vec<Value>>,
    notification_rules: Option<Vec<Value>>,
    action_allowlist: Option<Vec<Value>>,
    required_approval_line: Option<bool>,
    required_payment_line: Option<bool>,
}

fn normalize_update_request(
    body: UpdateWorkflowDefinitionRequest,
) -> Result<NormalizedWorkflowDefinitionUpdate, WorkflowStudioError> {
    if body.display_name.is_none()
        && body.definition.is_none()
        && body.approval_line.is_none()
        && body.payment_line.is_none()
        && body.notification_rules.is_none()
        && body.action_allowlist.is_none()
        && body.required_approval_line.is_none()
        && body.required_payment_line.is_none()
    {
        return Err(WorkflowStudioError::validation(
            "workflow draft update requires at least one field",
        ));
    }
    let display_name = body
        .display_name
        .map(|value| normalize_display_name(&value))
        .transpose()?;
    let definition = body
        .definition
        .map(validate_definition_for_optional_object_type)
        .transpose()?;
    if let Some(action_allowlist) = &body.action_allowlist {
        validate_action_allowlist(action_allowlist)?;
    }
    if let Some(notification_rules) = &body.notification_rules {
        validate_notification_rules(notification_rules)?;
    }
    Ok(NormalizedWorkflowDefinitionUpdate {
        display_name,
        definition,
        approval_line: body.approval_line,
        payment_line: body.payment_line,
        notification_rules: body.notification_rules,
        action_allowlist: body.action_allowlist,
        required_approval_line: body.required_approval_line,
        required_payment_line: body.required_payment_line,
    })
}

fn apply_draft_update(
    current: &WorkflowVersionRow,
    update: NormalizedWorkflowDefinitionUpdate,
) -> Result<WorkflowVersionRow, WorkflowStudioError> {
    ensure_editable(current)?;
    let mut next = current.clone();
    if let Some(display_name) = update.display_name {
        next.display_name = display_name;
    }
    if let Some(definition) = update.definition {
        next.definition = definition;
    }
    if let Some(approval_line) = update.approval_line {
        next.approval_line = approval_line;
    }
    if let Some(payment_line) = update.payment_line {
        next.payment_line = payment_line;
    }
    if let Some(notification_rules) = update.notification_rules {
        next.notification_rules = notification_rules;
    }
    if let Some(action_allowlist) = update.action_allowlist {
        next.action_allowlist = action_allowlist;
    }
    if let Some(required_approval_line) = update.required_approval_line {
        next.required_approval_line = required_approval_line;
    }
    if let Some(required_payment_line) = update.required_payment_line {
        next.required_payment_line = required_payment_line;
    }
    validate_definition_for_object_type(next.definition.clone(), &next.object_type)?;
    Ok(next)
}

fn ensure_draft_definition(
    row: &WorkflowVersionRow,
    operation: &'static str,
) -> Result<(), WorkflowStudioError> {
    if row.status == "DRAFT" {
        Ok(())
    } else {
        Err(KernelError::invalid_transition(format!(
            "only DRAFT workflow definitions can be {operation}"
        ))
        .into())
    }
}

fn ensure_editable(row: &WorkflowVersionRow) -> Result<(), WorkflowStudioError> {
    if row.status == "RETIRED" {
        return Err(KernelError::invalid_transition(
            "retired workflow definitions cannot be edited",
        )
        .into());
    }
    if row.pending_version.is_some() {
        return Err(KernelError::conflict(
            "a revision is already pending approval; approve or withdraw it before editing",
        )
        .into());
    }
    Ok(())
}

fn ensure_not_retired(row: &WorkflowVersionRow) -> Result<(), WorkflowStudioError> {
    if row.status == "RETIRED" {
        Err(
            KernelError::invalid_transition("archived workflow definitions cannot be changed")
                .into(),
        )
    } else {
        Ok(())
    }
}

fn keep_live_status(current: &WorkflowVersionRow) -> &'static str {
    if current.active_version.is_none() {
        return "DRAFT";
    }
    match current.status.as_str() {
        "PAUSED" => "PAUSED",
        _ => "ACTIVE",
    }
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

#[derive(Debug, Clone)]
struct WorkflowGraphNodeInfo {
    id: String,
    node_type: String,
    input_ports: Vec<WorkflowPortInfo>,
    output_ports: Vec<WorkflowPortInfo>,
}

#[derive(Debug, Clone)]
struct WorkflowPortInfo {
    key: String,
    port_type: String,
    required: bool,
    cardinality_one: bool,
}

fn validate_definition_for_object_type(
    value: Value,
    object_type: &str,
) -> Result<Value, WorkflowStudioError> {
    validate_definition_with_expected_object_type(value, Some(object_type))
}

fn validate_definition_for_optional_object_type(
    value: Value,
) -> Result<Value, WorkflowStudioError> {
    validate_definition_with_expected_object_type(value, None)
}

fn validate_definition_object(value: Value) -> Result<Value, WorkflowStudioError> {
    validate_definition_for_optional_object_type(value)
}

fn validate_definition_with_expected_object_type(
    value: Value,
    expected_object_type: Option<&str>,
) -> Result<Value, WorkflowStudioError> {
    let Some(object) = value.as_object() else {
        return Err(WorkflowStudioError::validation(
            "definition must be a JSON object",
        ));
    };
    let schema_version = object.get("schema_version").and_then(Value::as_str);
    // Executable node-graph definition (M2 runtime). Validated separately; the
    // authoring/policy schema below is left byte-identical.
    if schema_version == Some(WORKFLOW_EXEC_SCHEMA_VERSION) {
        validate_execution_graph(object)?;
        return Ok(value);
    }
    if schema_version != Some(WORKFLOW_DEFINITION_SCHEMA_VERSION) {
        return Err(WorkflowStudioError::validation(format!(
            "definition schema_version must be {WORKFLOW_DEFINITION_SCHEMA_VERSION} or {WORKFLOW_EXEC_SCHEMA_VERSION}"
        )));
    }
    if object.contains_key("cedar_policy") || object.contains_key("cedar_policy_text") {
        return Err(WorkflowStudioError::validation(
            "Workflow Studio policy decisions must use policy_decision templates, not arbitrary Cedar text",
        ));
    }
    if let Some(policy_decision) = object.get("policy_decision") {
        validate_policy_decision(policy_decision)?;
    }

    let findings = validate_canonical_workflow_definition(&value, expected_object_type);
    if findings.is_empty() {
        Ok(value)
    } else {
        Err(WorkflowStudioError::validation(
            format_workflow_definition_findings(&findings),
        ))
    }
}

fn validate_canonical_workflow_definition(
    value: &Value,
    expected_object_type: Option<&str>,
) -> Vec<WorkflowSimulationFinding> {
    let mut findings = Vec::new();
    let Some(definition) = value.as_object() else {
        push_workflow_definition_finding(
            &mut findings,
            "definition_object",
            "definition must be a JSON object",
        );
        return findings;
    };

    if definition.get("schema_version").and_then(Value::as_str)
        != Some(WORKFLOW_DEFINITION_SCHEMA_VERSION)
    {
        push_workflow_definition_finding(
            &mut findings,
            "schema_version",
            "definition schema_version must be workflow.definition.v1",
        );
    }

    let metadata = definition.get("metadata").and_then(Value::as_object);
    let metadata_object_type = metadata
        .and_then(|metadata| metadata.get("object_type"))
        .and_then(Value::as_str);
    match (expected_object_type, metadata_object_type) {
        (Some(expected), Some(actual)) if actual == expected => {}
        (Some(_), Some(_)) => push_workflow_definition_finding(
            &mut findings,
            "object_type_mismatch",
            "definition metadata object_type must match the workflow object type",
        ),
        (Some(_), None) => push_workflow_definition_finding(
            &mut findings,
            "object_type_mismatch",
            "definition metadata must include object_type matching the workflow object type",
        ),
        (None, Some(_)) => {}
        (None, None) => push_workflow_definition_finding(
            &mut findings,
            "object_type_mismatch",
            "definition metadata must include object_type",
        ),
    }
    let graph_object_type = expected_object_type.or(metadata_object_type);

    let Some(graph) = definition.get("graph").and_then(Value::as_object) else {
        push_workflow_definition_finding(
            &mut findings,
            "graph_object",
            "definition graph must be a JSON object",
        );
        return findings;
    };
    let Some(nodes) = graph.get("nodes").and_then(Value::as_array) else {
        push_workflow_definition_finding(
            &mut findings,
            "nodes_array",
            "definition graph.nodes must be an array",
        );
        return findings;
    };
    let Some(edges) = graph.get("edges").and_then(Value::as_array) else {
        push_workflow_definition_finding(
            &mut findings,
            "edges_array",
            "definition graph.edges must be an array",
        );
        return findings;
    };

    let mut parsed_nodes = Vec::with_capacity(nodes.len());
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for node in nodes {
        let Some(node_object) = node.as_object() else {
            push_workflow_definition_finding(
                &mut findings,
                "node_object",
                "workflow nodes must be JSON objects",
            );
            continue;
        };
        let id = non_empty_string(node, "id");
        let key = non_empty_string(node, "key");
        let node_type = non_empty_string(node, "type");
        let (Some(id), Some(key), Some(node_type)) = (id, key, node_type) else {
            push_workflow_definition_finding(
                &mut findings,
                "node_identity",
                "workflow nodes require non-empty id, key, and type",
            );
            continue;
        };

        if !ids.insert(id.to_owned()) {
            push_workflow_definition_finding(
                &mut findings,
                "duplicate_node_id",
                "workflow node ids must be unique",
            );
        }
        if !keys.insert(key.to_owned()) {
            push_workflow_definition_finding(
                &mut findings,
                "duplicate_node_key",
                "workflow node keys must be unique",
            );
        }
        if !is_allowed_workflow_node_type(node_type) {
            push_workflow_definition_finding(
                &mut findings,
                "unknown_node_type",
                "workflow node type is not server-owned or allowlisted",
            );
        }

        let input_ports = parse_workflow_ports(node, "input_ports", "input", &mut findings);
        let output_ports = parse_workflow_ports(node, "output_ports", "output", &mut findings);
        validate_node_config(node_object, node_type, graph_object_type, &mut findings);
        parsed_nodes.push(WorkflowGraphNodeInfo {
            id: id.to_owned(),
            node_type: node_type.to_owned(),
            input_ports,
            output_ports,
        });
    }

    let trigger_count = parsed_nodes
        .iter()
        .filter(|node| node.node_type == "trigger.form_submission")
        .count();
    if trigger_count == 0 {
        push_workflow_definition_finding(
            &mut findings,
            "missing_trigger",
            "exactly one workflow trigger is required",
        );
    } else if trigger_count > 1 {
        push_workflow_definition_finding(
            &mut findings,
            "too_many_triggers",
            "only one workflow trigger is allowed",
        );
    }
    if !parsed_nodes
        .iter()
        .any(|node| node.node_type == "end.state")
    {
        push_workflow_definition_finding(
            &mut findings,
            "missing_terminal",
            "at least one terminal end.state node is required",
        );
    }

    validate_workflow_edges(&parsed_nodes, edges, &mut findings);
    findings
}

fn validate_workflow_edges(
    nodes: &[WorkflowGraphNodeInfo],
    edges: &[Value],
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let nodes_by_id: HashMap<&str, &WorkflowGraphNodeInfo> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut inbound_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut outbound_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();

    for edge in edges {
        if !edge.is_object() {
            push_workflow_definition_finding(
                findings,
                "edge_object",
                "workflow edges must be JSON objects",
            );
            continue;
        }
        let from_node_id = non_empty_string(edge, "from_node_id");
        let from_port = non_empty_string(edge, "from_port");
        let to_node_id = non_empty_string(edge, "to_node_id");
        let to_port = non_empty_string(edge, "to_port");
        let (Some(from_node_id), Some(from_port), Some(to_node_id), Some(to_port)) =
            (from_node_id, from_port, to_node_id, to_port)
        else {
            push_workflow_definition_finding(
                findings,
                "invalid_edge_endpoint",
                "edge endpoints must reference existing node ids and port keys",
            );
            continue;
        };

        let Some(from_node) = nodes_by_id.get(from_node_id) else {
            push_workflow_definition_finding(
                findings,
                "invalid_edge_endpoint",
                "edge source node is not present in the graph",
            );
            continue;
        };
        let Some(to_node) = nodes_by_id.get(to_node_id) else {
            push_workflow_definition_finding(
                findings,
                "invalid_edge_endpoint",
                "edge target node is not present in the graph",
            );
            continue;
        };
        let source_port = from_node
            .output_ports
            .iter()
            .find(|port| port.key == from_port);
        let target_port = to_node.input_ports.iter().find(|port| port.key == to_port);
        let (Some(source_port), Some(target_port)) = (source_port, target_port) else {
            push_workflow_definition_finding(
                findings,
                "invalid_edge_endpoint",
                "edge references a missing input or output port",
            );
            continue;
        };
        if !workflow_ports_compatible(&source_port.port_type, &target_port.port_type) {
            push_workflow_definition_finding(
                findings,
                "incompatible_ports",
                "edge connects incompatible workflow port types",
            );
        }

        *outbound_counts
            .entry((from_node_id.to_owned(), from_port.to_owned()))
            .or_insert(0) += 1;
        *inbound_counts
            .entry((to_node_id.to_owned(), to_port.to_owned()))
            .or_insert(0) += 1;
        adjacency
            .entry(from_node_id.to_owned())
            .or_default()
            .push(to_node_id.to_owned());
    }

    for node in nodes {
        for port in &node.input_ports {
            let count = inbound_counts
                .get(&(node.id.clone(), port.key.clone()))
                .copied()
                .unwrap_or(0);
            if port.required && count == 0 {
                push_workflow_definition_finding(
                    findings,
                    "unconnected_input",
                    "required input ports must have an incoming edge",
                );
            }
            if port.cardinality_one && count > 1 {
                push_workflow_definition_finding(
                    findings,
                    "too_many_input_edges",
                    "single-cardinality input ports can only be connected once",
                );
            }
        }
        for port in &node.output_ports {
            let count = outbound_counts
                .get(&(node.id.clone(), port.key.clone()))
                .copied()
                .unwrap_or(0);
            if port.required && count == 0 {
                push_workflow_definition_finding(
                    findings,
                    "unconnected_output",
                    "required output ports must have an outgoing edge",
                );
            }
            if port.cardinality_one && count > 1 {
                push_workflow_definition_finding(
                    findings,
                    "too_many_output_edges",
                    "single-cardinality output ports can only be connected once",
                );
            }
        }
    }

    let trigger_nodes: Vec<&WorkflowGraphNodeInfo> = nodes
        .iter()
        .filter(|node| node.node_type == "trigger.form_submission")
        .collect();
    if let [trigger] = trigger_nodes.as_slice() {
        let reachable = reachable_workflow_node_ids(&trigger.id, &adjacency);
        for node in nodes {
            if !reachable.contains(&node.id) {
                push_workflow_definition_finding(
                    findings,
                    "unreachable_node",
                    "all workflow nodes must be reachable from the trigger",
                );
            }
        }
    }
}

fn validate_node_config(
    node: &serde_json::Map<String, Value>,
    node_type: &str,
    object_type: Option<&str>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let Some(config) = node.get("config").and_then(Value::as_object) else {
        push_workflow_definition_finding(
            findings,
            "node_config",
            "workflow nodes require a config object",
        );
        return;
    };
    if config.get("type").and_then(Value::as_str) != Some(node_type) {
        push_workflow_definition_finding(
            findings,
            "config_type_mismatch",
            "node config type must match node type",
        );
    }

    match node_type {
        "trigger.form_submission" => {
            validate_trigger_form_submission_config(config, object_type, findings);
        }
        "form.input" => {
            validate_form_input_config(config, object_type, findings);
        }
        "task.approval" => {
            let fallback_role = config
                .get("assignee_rule")
                .and_then(Value::as_object)
                .and_then(|rule| rule.get("fallback_role"))
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !fallback_role {
                push_workflow_definition_finding(
                    findings,
                    "missing_approval_fallback",
                    "approval task nodes require a fallback role",
                );
            }
        }
        "condition.branch" => {
            validate_condition_branch_config(node, config, findings);
        }
        "action.object_update" => {
            validate_object_update_config(config, object_type, findings);
        }
        "action.notification" => {
            let connector_key = config.get("connector_key").and_then(Value::as_str);
            let action_key = config.get("action_key").and_then(Value::as_str);
            match (connector_key, action_key) {
                (Some(connector_key), Some(action_key))
                    if connector_allows(connector_key, action_key) => {}
                _ => push_workflow_definition_finding(
                    findings,
                    "connector_action_not_allowlisted",
                    "notification connector action is not in the server-owned allowlist",
                ),
            }
        }
        "action.audit_append" => {
            let has_event_key = has_non_empty_config_string(config, "event_key");
            if !has_event_key {
                push_workflow_definition_finding(
                    findings,
                    "missing_audit_event",
                    "audit append nodes require an event_key",
                );
            }
        }
        "end.state" => {
            let has_status = has_non_empty_config_string(config, "status");
            if !has_status {
                push_workflow_definition_finding(
                    findings,
                    "missing_end_status",
                    "terminal nodes require a status",
                );
            }
        }
        _ => {}
    }
}

fn validate_trigger_form_submission_config(
    config: &serde_json::Map<String, Value>,
    object_type: Option<&str>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let source = config.get("source").and_then(Value::as_object);
    let source_object_type = source
        .and_then(|source| source.get("object_type"))
        .and_then(Value::as_str);
    let source_event = source
        .and_then(|source| source.get("event"))
        .and_then(Value::as_str);
    let source_scope = source
        .and_then(|source| source.get("scope"))
        .and_then(Value::as_str);

    if source_object_type.is_none()
        || source_event != Some("submitted")
        || source_scope != Some("org")
    {
        push_workflow_definition_finding(
            findings,
            "trigger_source",
            "trigger nodes require server-owned submitted/org source metadata",
        );
    }
    if let (Some(expected), Some(actual)) = (object_type, source_object_type)
        && actual != expected
    {
        push_workflow_definition_finding(
            findings,
            "object_type_mismatch",
            "trigger source object_type must match the workflow object type",
        );
    }
}

fn validate_form_input_config(
    config: &serde_json::Map<String, Value>,
    object_type: Option<&str>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let Some(fields) = config.get("fields").and_then(Value::as_array) else {
        push_workflow_definition_finding(
            findings,
            "missing_form_fields",
            "form input nodes require at least one field",
        );
        return;
    };
    if fields.is_empty() {
        push_workflow_definition_finding(
            findings,
            "missing_form_fields",
            "form input nodes require at least one field",
        );
        return;
    }

    for field in fields {
        let Some(field) = field.as_object() else {
            push_workflow_definition_finding(
                findings,
                "invalid_form_field",
                "form fields must be JSON objects",
            );
            continue;
        };
        if field.get("field_type").and_then(Value::as_str) == Some("object_ref") {
            let field_object_type = field.get("object_type").and_then(Value::as_str);
            if let (Some(expected), Some(actual)) = (object_type, field_object_type)
                && actual != expected
            {
                push_workflow_definition_finding(
                    findings,
                    "object_type_mismatch",
                    "form object_ref fields must match the workflow object type",
                );
            } else if field_object_type.is_none() {
                push_workflow_definition_finding(
                    findings,
                    "object_type_mismatch",
                    "form object_ref fields require object_type",
                );
            }
        }
    }
}

fn validate_condition_branch_config(
    node: &serde_json::Map<String, Value>,
    config: &serde_json::Map<String, Value>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    validate_condition_expression(config.get("expression"), findings);

    let declared_branch_ports = declared_branch_output_ports(node);
    let Some(branches) = config.get("branches").and_then(Value::as_array) else {
        push_workflow_definition_finding(
            findings,
            "missing_condition_branches",
            "condition nodes require at least two branches",
        );
        return;
    };
    if branches.len() < 2 {
        push_workflow_definition_finding(
            findings,
            "missing_condition_branches",
            "condition nodes require at least two branches",
        );
    }

    let mut branch_ports = HashSet::new();
    for branch in branches {
        let Some(branch) = branch.as_object() else {
            push_workflow_definition_finding(
                findings,
                "invalid_condition_branch",
                "condition branches must be JSON objects",
            );
            continue;
        };
        let port = branch.get("port").and_then(Value::as_str);
        let label = branch.get("label").and_then(Value::as_str);
        let when = branch.get("when").and_then(Value::as_str);
        let valid = port.is_some_and(|port| {
            !port.trim().is_empty()
                && branch_ports.insert(port.to_owned())
                && declared_branch_ports.contains(port)
        }) && label.is_some_and(|label| !label.trim().is_empty())
            && matches!(when, Some("true" | "false"));
        if !valid {
            push_workflow_definition_finding(
                findings,
                "invalid_condition_branch",
                "condition branch ports must be declared server-owned true/false output ports",
            );
        }
    }

    if declared_branch_ports.len() != branch_ports.len()
        || declared_branch_ports
            .iter()
            .any(|port| !branch_ports.contains(port))
    {
        push_workflow_definition_finding(
            findings,
            "invalid_condition_branch",
            "condition branch config must declare exactly the server-owned branch output ports",
        );
    }

    let default_port = config.get("default_port").and_then(Value::as_str);
    if default_port.is_none_or(|port| {
        port.trim().is_empty()
            || !branch_ports.contains(port)
            || !declared_branch_ports.contains(port)
    }) {
        push_workflow_definition_finding(
            findings,
            "invalid_condition_default",
            "condition default_port must reference a declared branch port",
        );
    }
}

fn validate_condition_expression(
    expression: Option<&Value>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let Some(expression) = expression.and_then(Value::as_object) else {
        push_workflow_definition_finding(
            findings,
            "invalid_condition_expression",
            "condition expression must be a server-owned expression object",
        );
        return;
    };
    let op = expression.get("op").and_then(Value::as_str);
    let left_ref = expression
        .get("left")
        .and_then(Value::as_object)
        .and_then(|left| left.get("ref"))
        .and_then(Value::as_str);
    let right = expression.get("right");
    if !matches!(
        op,
        Some("equals" | "not_equals" | "in" | "not_in" | "exists")
    ) || left_ref != Some("approval.result")
        || right.is_none_or(|right| !(right.is_string() || right.is_boolean() || right.is_number()))
    {
        push_workflow_definition_finding(
            findings,
            "invalid_condition_expression",
            "condition expression must use the server-owned approval.result grammar",
        );
    }
}

fn validate_object_update_config(
    config: &serde_json::Map<String, Value>,
    object_type: Option<&str>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let action_id = config.get("action_id").and_then(Value::as_str);
    let requires_policy = config.get("requires_policy").and_then(Value::as_str);
    if let Some(object_type) = object_type {
        let expected_action = format!("{object_type}.update_status");
        if action_id != Some(expected_action.as_str())
            || requires_policy != Some(expected_action.as_str())
        {
            push_workflow_definition_finding(
                findings,
                "object_action_not_allowlisted",
                "object update action and policy must match the server-owned workflow action allowlist",
            );
        }
    } else if action_id.is_none() || requires_policy.is_none() {
        push_workflow_definition_finding(
            findings,
            "object_action_not_allowlisted",
            "object update action and policy are required",
        );
    }

    let target_from = config
        .get("target")
        .and_then(Value::as_object)
        .and_then(|target| target.get("from"))
        .and_then(Value::as_str);
    if target_from != Some("trigger.object_ref") {
        push_workflow_definition_finding(
            findings,
            "invalid_object_update_target",
            "object update target must be the server-owned trigger.object_ref handle",
        );
    }

    validate_object_update_input(config.get("input"), findings);
}

fn validate_object_update_input(
    input: Option<&Value>,
    findings: &mut Vec<WorkflowSimulationFinding>,
) {
    let Some(input) = input.and_then(Value::as_object) else {
        push_workflow_definition_finding(
            findings,
            "invalid_object_update_input",
            "object update input must be a server-owned status update mapping",
        );
        return;
    };
    let status = input.get("status").and_then(Value::as_str);
    let updated_by = input_value_from_handle(input.get("updated_by"));
    let updated_at = input_value_from_handle(input.get("updated_at"));
    if input.len() != 3
        || !matches!(
            status,
            Some("approved" | "rejected" | "cancelled" | "completed" | "failed")
        )
        || updated_by != Some("approval.actor_id")
        || updated_at != Some("system.now")
    {
        push_workflow_definition_finding(
            findings,
            "invalid_object_update_input",
            "object update input may only map status plus approval.actor_id/system.now handles",
        );
    }
}

fn input_value_from_handle(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get("from"))
        .and_then(Value::as_str)
}

fn declared_branch_output_ports(node: &serde_json::Map<String, Value>) -> HashSet<String> {
    node.get("output_ports")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|port| {
            let port = port.as_object()?;
            let key = port.get("key")?.as_str()?;
            let direction = port.get("direction").and_then(Value::as_str);
            let port_type = port.get("type").and_then(Value::as_str);
            (direction == Some("output") && port_type == Some("flow.branch"))
                .then(|| key.to_owned())
        })
        .collect()
}

fn parse_workflow_ports(
    node: &Value,
    field: &'static str,
    direction: &'static str,
    findings: &mut Vec<WorkflowSimulationFinding>,
) -> Vec<WorkflowPortInfo> {
    let Some(ports) = node.get(field).and_then(Value::as_array) else {
        push_workflow_definition_finding(
            findings,
            "ports_array",
            "workflow node ports must be arrays",
        );
        return Vec::new();
    };
    let mut parsed = Vec::with_capacity(ports.len());
    for port in ports {
        let Some(port_object) = port.as_object() else {
            push_workflow_definition_finding(
                findings,
                "invalid_port",
                "workflow ports must be JSON objects",
            );
            continue;
        };
        let key = non_empty_string(port, "key");
        let port_direction = port_object.get("direction").and_then(Value::as_str);
        let port_type = port_object.get("type").and_then(Value::as_str);
        let cardinality = port_object.get("cardinality").and_then(Value::as_str);
        let (Some(key), Some(port_type), Some(cardinality)) = (key, port_type, cardinality) else {
            push_workflow_definition_finding(
                findings,
                "invalid_port",
                "workflow ports require key, direction, allowed type, and cardinality",
            );
            continue;
        };
        if port_direction != Some(direction)
            || !is_allowed_workflow_port_type(port_type)
            || !matches!(cardinality, "one" | "many")
        {
            push_workflow_definition_finding(
                findings,
                "invalid_port",
                "workflow ports require key, direction, allowed type, and cardinality",
            );
            continue;
        }
        parsed.push(WorkflowPortInfo {
            key: key.to_owned(),
            port_type: port_type.to_owned(),
            required: port_object
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            cardinality_one: cardinality == "one",
        });
    }
    parsed
}

fn has_non_empty_config_string(config: &serde_json::Map<String, Value>, field: &str) -> bool {
    config
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn non_empty_string<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn is_allowed_workflow_node_type(node_type: &str) -> bool {
    matches!(
        node_type,
        "trigger.form_submission"
            | "form.input"
            | "task.approval"
            | "condition.branch"
            | "action.object_update"
            | "action.notification"
            | "action.audit_append"
            | "end.state"
    )
}

fn is_allowed_workflow_port_type(port_type: &str) -> bool {
    matches!(
        port_type,
        "flow.start"
            | "flow.next"
            | "flow.branch"
            | "flow.terminal"
            | "data.form_payload"
            | "data.approval_result"
            | "data.object_ref"
            | "data.audit_event"
    )
}

fn workflow_ports_compatible(output: &str, input: &str) -> bool {
    output == input
        || (input == "flow.terminal"
            && matches!(output, "flow.next" | "flow.branch" | "flow.terminal"))
        || (input == "flow.next" && output == "flow.branch")
}

fn reachable_workflow_node_ids(
    start_node_id: &str,
    adjacency: &HashMap<String, Vec<String>>,
) -> HashSet<String> {
    let mut reachable = HashSet::new();
    let mut queue = VecDeque::from([start_node_id.to_owned()]);
    while let Some(node_id) = queue.pop_front() {
        if !reachable.insert(node_id.clone()) {
            continue;
        }
        if let Some(next_nodes) = adjacency.get(&node_id) {
            queue.extend(next_nodes.iter().cloned());
        }
    }
    reachable
}

fn push_workflow_definition_finding(
    findings: &mut Vec<WorkflowSimulationFinding>,
    code: &'static str,
    message: &'static str,
) {
    findings.push(WorkflowSimulationFinding {
        severity: "blocker".to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
    });
}

fn format_workflow_definition_findings(findings: &[WorkflowSimulationFinding]) -> String {
    let mut parts: Vec<String> = findings
        .iter()
        .take(8)
        .map(|finding| format!("{}: {}", finding.code, finding.message))
        .collect();
    if findings.len() > parts.len() {
        parts.push(format!(
            "{} more validation blockers",
            findings.len() - parts.len()
        ));
    }
    format!(
        "workflow.definition.v1 graph validation failed: {}",
        parts.join("; ")
    )
}

/// Validate a `wf.exec.v1` executable definition's node graph (design §3/§template).
/// Every node needs a stable `node_key` + a known `node_type`; a `job` node must fan
/// out through an allowlisted connector, so the completion→approval→payroll template
/// cannot publish without the `internal.jobs` connector.
fn validate_execution_graph(
    object: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    let nodes = object
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|nodes| !nodes.is_empty())
        .ok_or_else(|| {
            WorkflowStudioError::validation("execution definition requires a non-empty nodes array")
        })?;
    for node in nodes {
        let node = node.as_object().ok_or_else(|| {
            WorkflowStudioError::validation("execution nodes must be JSON objects")
        })?;
        required_string(node, "node_key")?;
        match required_string(node, "node_type")? {
            "object_gate" | "object_mutation" => {}
            "human_task" => {
                required_string(node, "assignee_role_key")?;
            }
            "job" => {
                let connector_key = required_string(node, "connector_key")?;
                let action_key = required_string(node, "action_key")?;
                if !connector_allows(connector_key, action_key) {
                    return Err(WorkflowStudioError::validation(
                        "execution node job action is not in the Workflow Studio connector allowlist",
                    ));
                }
            }
            "guard.checklist_attestation" => {
                validate_execution_checklist_guard(node)?;
            }
            "guard.four_eyes_peer_review" => {
                validate_execution_four_eyes_guard(node)?;
            }
            "guard.segregation_of_duties" => {
                validate_execution_sod_guard(node)?;
            }
            "guard.egress_policy" => {
                validate_execution_egress_guard(node)?;
            }
            _ => {
                return Err(WorkflowStudioError::validation(
                    "unsupported execution node_type",
                ));
            }
        }
    }
    Ok(())
}

fn validate_execution_checklist_guard(
    node: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    let config = execution_guard_config(node)?;
    ensure_allowed_guard_fields(
        config,
        &[
            "label",
            "required_policy",
            "audit_event_key",
            "assignee_role_key",
            "items",
            "approve_requires_all_required",
            "reject_requires_memo",
            "step_up_required",
            "passkey_purpose",
            "due_after",
            "redaction",
            "on_missing_fact",
        ],
    )?;
    required_string(config, "label")?;
    validate_optional_feature_key(config.get("required_policy"))?;
    validate_optional_audit_event_key(config.get("audit_event_key"))?;
    let items = required_array(config, "items")?;
    if items.is_empty() || items.len() > 50 {
        return Err(WorkflowStudioError::validation(
            "checklist guardrail requires 1..=50 items",
        ));
    }
    for item in items {
        let item = item.as_object().ok_or_else(|| {
            WorkflowStudioError::validation("checklist guardrail items must be objects")
        })?;
        ensure_allowed_guard_fields(
            item,
            &[
                "key",
                "label",
                "kind",
                "required",
                "min_count",
                "source_ref",
            ],
        )?;
        required_string(item, "key")?;
        required_string(item, "label")?;
        match required_string(item, "kind")? {
            "checkbox" | "text" | "evidence_ref" | "object_ref" | "policy_ack" => {}
            _ => {
                return Err(WorkflowStudioError::validation(
                    "checklist guardrail item kind is not server-owned",
                ));
            }
        }
    }
    Ok(())
}

fn validate_execution_four_eyes_guard(
    node: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    let config = execution_guard_config(node)?;
    ensure_allowed_guard_fields(
        config,
        &[
            "label",
            "required_policy",
            "audit_event_key",
            "assignee_role_key",
            "subject_actor_refs",
            "min_reviewers",
            "forbid_same_actor",
            "allow_org_lead_exemption",
            "allow_super_admin_exemption",
            "exemption_requires_memo",
            "step_up_required",
            "reject_requires_memo",
            "passkey_purpose",
            "due_after",
            "redaction",
            "on_missing_fact",
        ],
    )?;
    required_string(config, "label")?;
    validate_optional_feature_key(config.get("required_policy"))?;
    validate_optional_audit_event_key(config.get("audit_event_key"))?;
    let subject_actor_refs = required_array(config, "subject_actor_refs")?;
    if subject_actor_refs.is_empty()
        || subject_actor_refs
            .iter()
            .any(|value| value.as_str().is_none_or(str::is_empty))
    {
        return Err(WorkflowStudioError::validation(
            "four-eyes guardrail requires non-empty subject_actor_refs",
        ));
    }
    if let Some(min_reviewers) = config.get("min_reviewers").and_then(Value::as_u64)
        && !(1..=4).contains(&min_reviewers)
    {
        return Err(WorkflowStudioError::validation(
            "four-eyes guardrail min_reviewers must be 1..=4",
        ));
    }
    Ok(())
}

fn validate_execution_sod_guard(
    node: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    let config = execution_guard_config(node)?;
    ensure_allowed_guard_fields(
        config,
        &[
            "label",
            "policy_key",
            "audit_event_key",
            "actor_under_test_ref",
            "blocked_actor_refs",
            "blocked_role_refs",
            "scope",
            "mode",
            "exemptions",
            "exemption_requires_memo",
            "on_missing_fact",
        ],
    )?;
    required_string(config, "label")?;
    required_string(config, "policy_key")?;
    validate_optional_audit_event_key(config.get("audit_event_key"))?;
    let blocked_actor_refs = required_array(config, "blocked_actor_refs")?;
    if blocked_actor_refs.is_empty()
        || blocked_actor_refs
            .iter()
            .any(|value| value.as_str().is_none_or(str::is_empty))
    {
        return Err(WorkflowStudioError::validation(
            "SoD guardrail requires non-empty blocked_actor_refs",
        ));
    }
    if let Some(mode) = config.get("mode").and_then(Value::as_str)
        && !matches!(mode, "hard_block" | "allow_with_governance_finding")
    {
        return Err(WorkflowStudioError::validation(
            "SoD guardrail mode is not server-owned",
        ));
    }
    Ok(())
}

fn validate_execution_egress_guard(
    node: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    let config = execution_guard_config(node)?;
    ensure_allowed_guard_fields(
        config,
        &[
            "label",
            "egress_kind",
            "channel",
            "required_policy",
            "audit_event_key",
            "manual_review_role_key",
            "external_recipient_policy",
            "step_up_required",
            "passkey_purpose",
            "classification_ref",
            "data_classes",
            "lifecycle_requirements",
            "on_missing_fact",
        ],
    )?;
    required_string(config, "label")?;
    let egress_kind = required_string(config, "egress_kind")?;
    if !matches!(
        egress_kind,
        "mail" | "export" | "webhook" | "job" | "document_download"
    ) {
        return Err(WorkflowStudioError::validation(
            "egress guardrail kind is not server-owned",
        ));
    }
    required_string(config, "channel")?;
    validate_optional_feature_key(config.get("required_policy"))?;
    validate_optional_audit_event_key(config.get("audit_event_key"))?;
    if matches!(egress_kind, "mail" | "export" | "document_download") {
        required_string(config, "classification_ref")?;
    }
    if let Some(policy) = config
        .get("external_recipient_policy")
        .and_then(Value::as_str)
        && !matches!(policy, "block" | "allow_if_approved" | "manual_review")
    {
        return Err(WorkflowStudioError::validation(
            "egress guardrail external_recipient_policy is not server-owned",
        ));
    }
    Ok(())
}

fn execution_guard_config(
    node: &serde_json::Map<String, Value>,
) -> Result<&serde_json::Map<String, Value>, WorkflowStudioError> {
    if let Some(config) = node.get("config") {
        for key in node.keys() {
            if !matches!(key.as_str(), "node_key" | "node_type" | "config") {
                return Err(WorkflowStudioError::validation(
                    "guardrail execution node contains an unsupported top-level field",
                ));
            }
        }
        return config.as_object().ok_or_else(|| {
            WorkflowStudioError::validation("guardrail execution node config must be an object")
        });
    }
    Ok(node)
}

fn ensure_allowed_guard_fields(
    config: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), WorkflowStudioError> {
    let allowed: HashSet<&str> = allowed.iter().copied().collect();
    for key in config.keys() {
        if matches!(key.as_str(), "node_key" | "node_type" | "config") {
            continue;
        }
        if !allowed.contains(key.as_str()) {
            return Err(WorkflowStudioError::validation(
                "guardrail execution config contains an unsupported field",
            ));
        }
    }
    Ok(())
}

fn required_array<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<&'a Vec<Value>, WorkflowStudioError> {
    object.get(key).and_then(Value::as_array).ok_or_else(|| {
        WorkflowStudioError::validation(format!("guardrail config {key} array is required"))
    })
}

fn validate_optional_feature_key(value: Option<&Value>) -> Result<(), WorkflowStudioError> {
    if let Some(value) = value {
        let policy = value.as_str().ok_or_else(|| {
            WorkflowStudioError::validation("guardrail required_policy must be a Feature key")
        })?;
        Feature::from_str(policy).map_err(WorkflowStudioError::from)?;
    }
    Ok(())
}

fn validate_optional_audit_event_key(value: Option<&Value>) -> Result<(), WorkflowStudioError> {
    if let Some(value) = value {
        let action = value.as_str().ok_or_else(|| {
            WorkflowStudioError::validation("guardrail audit_event_key must be a string")
        })?;
        AuditAction::new(action).map_err(WorkflowStudioError::from)?;
        if !action.starts_with("workflow_guardrail.") {
            return Err(WorkflowStudioError::validation(
                "guardrail audit_event_key must use the workflow_guardrail namespace",
            ));
        }
    }
    Ok(())
}

fn validate_policy_decision(value: &Value) -> Result<(), WorkflowStudioError> {
    let object = value
        .as_object()
        .ok_or_else(|| WorkflowStudioError::validation("policy_decision must be a JSON object"))?;
    let template_key = required_string(object, "template_key")?;
    if template_key != POLICY_TEMPLATE_EQUIPMENT_LOCATION_ACCESS {
        Err(WorkflowStudioError::validation(
            "only equipment_location_access policy_decision is supported in this slice",
        ))
    } else if required_string(object, "effect")? != "allow" {
        Err(WorkflowStudioError::validation(
            "policy_decision effect must be allow",
        ))
    } else if required_string(object, "action")? != POLICY_ACTION_START_WORK_ORDER {
        Err(WorkflowStudioError::validation(format!(
            "policy_decision action must be {POLICY_ACTION_START_WORK_ORDER}"
        )))
    } else {
        validate_policy_resource(required_object(object, "resource")?)?;
        validate_policy_context(required_object(object, "context")?)?;
        validate_policy_scope(required_object(object, "scope")?)?;
        validate_policy_requirements(required_object(object, "requirements")?)?;
        Ok(())
    }
}

fn validate_policy_resource(
    resource: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    if required_string(resource, "type")? != "equipment" {
        return Err(WorkflowStudioError::validation(
            "policy_decision resource.type must be equipment",
        ));
    }
    required_string(resource, "id")?;
    Ok(())
}

fn validate_policy_context(
    context: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    for key in ["org_id", "location_id", "subject_role"] {
        required_string(context, key)?;
    }
    if context
        .get("passkey_step_up_satisfied")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(WorkflowStudioError::validation(
            "policy_decision context.passkey_step_up_satisfied must be true",
        ));
    }
    Ok(())
}

fn validate_policy_scope(
    scope: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    for key in ["org_id", "location_id"] {
        required_string(scope, key)?;
    }
    Ok(())
}

fn validate_policy_requirements(
    requirements: &serde_json::Map<String, Value>,
) -> Result<(), WorkflowStudioError> {
    if requirements.get("passkey_step_up").and_then(Value::as_bool) != Some(true) {
        return Err(WorkflowStudioError::validation(
            "policy_decision requirements.passkey_step_up must be true",
        ));
    }
    required_string(requirements, "audit_event")?;
    Ok(())
}

fn required_object<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<&'a serde_json::Map<String, Value>, WorkflowStudioError> {
    object.get(key).and_then(Value::as_object).ok_or_else(|| {
        WorkflowStudioError::validation(format!("policy_decision {key} is required"))
    })
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &'static str,
) -> Result<&'a str, WorkflowStudioError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            WorkflowStudioError::validation(format!("policy_decision {key} is required"))
        })
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
            return Err(WorkflowStudioError::validation(
                "action_allowlist entry is not in the Workflow Studio connector allowlist",
            ));
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
            return Err(WorkflowStudioError::validation(
                "notification action is not allowlisted",
            ));
        }
    }
    Ok(())
}

fn connector_allows(connector_key: &str, action_key: &str) -> bool {
    ALLOWED_CONNECTORS.iter().any(|connector| {
        connector.connector_key == connector_key && connector.action_keys.contains(&action_key)
    })
}

fn validation_findings(row: &WorkflowVersionRow) -> Vec<WorkflowSimulationFinding> {
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
    if row.definition.get("schema_version").and_then(Value::as_str)
        == Some(WORKFLOW_EXEC_SCHEMA_VERSION)
    {
        if let Err(error) = validate_definition_object(row.definition.clone()) {
            findings.push(WorkflowSimulationFinding {
                severity: "blocker".to_owned(),
                code: "invalid_execution_definition".to_owned(),
                message: error.message,
            });
        }
    } else {
        findings.extend(validate_canonical_workflow_definition(
            &row.definition,
            Some(&row.object_type),
        ));
        if row.definition.get("cedar_policy").is_some()
            || row.definition.get("cedar_policy_text").is_some()
        {
            findings.push(WorkflowSimulationFinding {
                severity: "blocker".to_owned(),
                code: "arbitrary_policy_text".to_owned(),
                message: "Workflow Studio policy decisions must use policy_decision templates, not arbitrary Cedar text".to_owned(),
            });
        }
        if let Some(policy_decision) = row.definition.get("policy_decision")
            && let Err(error) = validate_policy_decision(policy_decision)
        {
            findings.push(WorkflowSimulationFinding {
                severity: "blocker".to_owned(),
                code: "invalid_policy_decision".to_owned(),
                message: error.message,
            });
        }
    }
    findings
}

fn validate_publishable(row: &WorkflowVersionRow) -> Vec<WorkflowSimulationFinding> {
    validation_findings(row)
        .into_iter()
        .filter(|finding| finding.severity == "blocker")
        .collect()
}

fn format_publish_findings(findings: Vec<WorkflowSimulationFinding>) -> String {
    findings
        .into_iter()
        .map(|finding| format!("{}: {}", finding.code, finding.message))
        .collect::<Vec<_>>()
        .join("; ")
}

fn simulation_for(row: &WorkflowVersionRow) -> WorkflowSimulationResponse {
    let mut findings = validation_findings(row);
    if let Some(finding) = policy_decision_metadata_finding(&row.definition) {
        findings.push(finding);
    }
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

fn policy_decision_metadata_finding(definition: &Value) -> Option<WorkflowSimulationFinding> {
    if validate_definition_object(definition.clone()).is_err() {
        return None;
    }
    let decision = definition.get("policy_decision")?;
    let object = decision.as_object()?;
    let resource = object.get("resource")?.as_object()?;
    let scope = object.get("scope")?.as_object()?;
    Some(WorkflowSimulationFinding {
        severity: "info".to_owned(),
        code: "policy_decision_metadata".to_owned(),
        message: format!(
            "Cedar/PBAC tuple schema={} template={} effect={} action={} resource={}:{} context=org_id,location_id,subject_role,passkey_step_up_satisfied scope={}/{}",
            WORKFLOW_DEFINITION_SCHEMA_VERSION,
            object.get("template_key")?.as_str()?,
            object.get("effect")?.as_str()?,
            object.get("action")?.as_str()?,
            resource.get("type")?.as_str()?,
            resource.get("id")?.as_str()?,
            scope.get("org_id")?.as_str()?,
            scope.get("location_id")?.as_str()?
        ),
    })
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

fn json_string_array(value: Value) -> Vec<String> {
    match value {
        Value::Array(values) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
            .collect(),
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
        assert!(!err.message.contains("external.random"));
        assert!(!err.message.contains("post_secret"));
        Ok(())
    }

    /// The canonical completion→approval→payroll executable node graph (design
    /// §template). Published via Studio as a `wf.exec.v1` definition; the M2 runtime
    /// walks it. `emit_payroll` fans out through the `internal.jobs` JOB connector.
    fn maintenance_completion_execution_definition() -> Value {
        json!({
            "schema_version": WORKFLOW_EXEC_SCHEMA_VERSION,
            "workflow_key": "work_order.maintenance_completion",
            "object_type": "work_order",
            "nodes": [
                { "node_key": "mechanic_report", "node_type": "object_gate" },
                {
                    "node_key": "admin_approval",
                    "node_type": "human_task",
                    "title": "관리자 완료 승인",
                    "required_policy": "completion_review",
                    "assignee_role_key": "admin"
                },
                {
                    "node_key": "executive_approval",
                    "node_type": "human_task",
                    "title": "임원 완료 승인",
                    "required_policy": "completion_review",
                    "assignee_role_key": "executive"
                },
                {
                    "node_key": "apply_completion",
                    "node_type": "object_mutation",
                    "object_type": "work_order",
                    "target_status": "FINAL_COMPLETED"
                },
                {
                    "node_key": "emit_payroll",
                    "node_type": "job",
                    "connector_key": "internal.jobs",
                    "action_key": "draft_payroll_run",
                    "channel": "JOB",
                    "destination_ref": "payroll.draft_run",
                    "job": "payroll_draft"
                }
            ],
            "edges": [
                { "from": "mechanic_report", "to": "admin_approval" },
                { "from": "admin_approval", "to": "executive_approval" },
                { "from": "executive_approval", "to": "apply_completion" },
                { "from": "apply_completion", "to": "emit_payroll" }
            ]
        })
    }

    #[test]
    fn completion_approval_payroll_execution_graph_validates() -> Result<(), String> {
        // The canonical wf.exec.v1 completion→approval→payroll graph is a valid
        // executable definition.
        validate_definition_object(maintenance_completion_execution_definition())
            .map_err(|err| format!("canonical execution graph must validate: {}", err.message))?;
        // Its payroll JOB action publishes only because internal.jobs is allowlisted.
        assert!(connector_allows("internal.jobs", "draft_payroll_run"));
        // The publish-time action_allowlist check (validate_action_allowlist) accepts
        // the JOB connector entry the template carries.
        validate_action_allowlist(&[json!({
            "connector_key": "internal.jobs",
            "action_key": "draft_payroll_run"
        })])
        .map_err(|err| {
            format!(
                "internal.jobs.draft_payroll_run must allowlist: {}",
                err.message
            )
        })?;
        Ok(())
    }

    #[test]
    fn execution_graph_job_node_requires_allowlisted_connector() -> Result<(), String> {
        // Swap the payroll node onto an unknown connector: publish-validation of the
        // graph must fail closed (internal.jobs is genuinely load-bearing).
        let mut definition = maintenance_completion_execution_definition();
        definition["nodes"][4]["connector_key"] = json!("external.random");
        let err = match validate_definition_object(definition) {
            Ok(_) => return Err("a job node on an unlisted connector must fail closed".to_owned()),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains("connector allowlist"));
        assert!(!err.message.contains("external.random"));
        Ok(())
    }

    #[test]
    fn execution_graph_accepts_guardrail_control_point_nodes() -> Result<(), String> {
        let definition = json!({
            "schema_version": WORKFLOW_EXEC_SCHEMA_VERSION,
            "workflow_key": "work_order.guarded_completion",
            "object_type": "work_order",
            "nodes": [
                {
                    "node_key": "guard.checklist.ops_attestation",
                    "node_type": "guard.checklist_attestation",
                    "label": "Operations attestation",
                    "required_policy": "completion_review",
                    "assignee_role_key": "operations.manager",
                    "items": [{
                        "key": "evidence_uploaded",
                        "label": "Evidence uploaded",
                        "kind": "evidence_ref",
                        "required": true,
                        "min_count": 1
                    }]
                },
                {
                    "node_key": "guard.four_eyes.peer_review",
                    "node_type": "guard.four_eyes_peer_review",
                    "label": "Peer review",
                    "required_policy": "completion_review",
                    "assignee_role_key": "operations.manager",
                    "subject_actor_refs": ["run.initiated_by"],
                    "min_reviewers": 1
                },
                {
                    "node_key": "guard.sod.purchase_approval",
                    "node_type": "guard.segregation_of_duties",
                    "label": "Purchase approver must differ",
                    "policy_key": "purchase.self_approval",
                    "actor_under_test_ref": "run.current_actor",
                    "blocked_actor_refs": ["object.requested_by"],
                    "mode": "hard_block"
                },
                {
                    "node_key": "guard.egress.mail",
                    "node_type": "guard.egress_policy",
                    "label": "Mail egress gate",
                    "egress_kind": "mail",
                    "channel": "internal.mail",
                    "required_policy": "mail_use",
                    "classification_ref": "mail.thread.classification",
                    "external_recipient_policy": "block"
                }
            ],
            "edges": []
        });

        validate_definition_object(definition.clone()).map_err(|err| err.message)?;

        let mut invalid = definition;
        invalid["nodes"][0]["browser_supplied_org_id"] = json!("must-not-be-accepted");
        let err = match validate_definition_object(invalid) {
            Ok(_) => return Err("browser-supplied guardrail fields must fail closed".to_owned()),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains("unsupported field"));
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
            pending_version: None,
            pending_staged_by: None,
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

    #[test]
    fn create_rejects_invalid_canonical_workflow_graphs() -> Result<(), String> {
        let mut missing_schema = canonical_workflow_definition("leave_request");
        missing_schema
            .as_object_mut()
            .ok_or_else(|| "definition fixture must be an object".to_owned())?
            .remove("schema_version");

        let mut object_type_mismatch = canonical_workflow_definition("leave_request");
        object_type_mismatch["metadata"]["object_type"] = json!("work_order");

        let mut missing_trigger = canonical_workflow_definition("leave_request");
        missing_trigger["graph"]["nodes"]
            .as_array_mut()
            .ok_or_else(|| "nodes fixture must be an array".to_owned())?
            .retain(|node| node["type"] != "trigger.form_submission");

        let mut missing_terminal = canonical_workflow_definition("leave_request");
        missing_terminal["graph"]["nodes"]
            .as_array_mut()
            .ok_or_else(|| "nodes fixture must be an array".to_owned())?
            .retain(|node| node["type"] != "end.state");

        let mut duplicate_node_id = canonical_workflow_definition("leave_request");
        duplicate_node_id["graph"]["nodes"][1]["id"] = json!("node-trigger");

        let mut invalid_edge_endpoint = canonical_workflow_definition("leave_request");
        invalid_edge_endpoint["graph"]["edges"][0]["to_node_id"] = json!("node-missing");

        let mut unknown_node_type = canonical_workflow_definition("leave_request");
        unknown_node_type["graph"]["nodes"][1]["type"] = json!("action.raw_http");
        unknown_node_type["graph"]["nodes"][1]["config"]["type"] = json!("action.raw_http");

        let mut unknown_connector_action = canonical_workflow_definition("leave_request");
        unknown_connector_action["graph"]["nodes"][5]["config"]["action_key"] =
            json!("post_secret");

        let cases = [
            ("schema_version", missing_schema),
            ("object_type_mismatch", object_type_mismatch),
            ("missing_trigger", missing_trigger),
            ("missing_terminal", missing_terminal),
            ("duplicate_node_id", duplicate_node_id),
            ("invalid_edge_endpoint", invalid_edge_endpoint),
            ("unknown_node_type", unknown_node_type),
            ("connector_action_not_allowlisted", unknown_connector_action),
        ];

        for (expected_code, definition) in cases {
            let err = match normalize_create_request(create_request(definition, "leave_request")) {
                Ok(_) => return Err("invalid canonical workflow graph must fail closed".to_owned()),
                Err(err) => err,
            };
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                err.message.contains(expected_code),
                "expected validation message to contain {expected_code}, got {}",
                err.message
            );
        }

        Ok(())
    }

    #[test]
    fn create_rejects_unsafe_condition_branch_config() -> Result<(), String> {
        let mut invalid_expression_op = canonical_workflow_definition("leave_request");
        invalid_expression_op["graph"]["nodes"][3]["config"]["expression"]["op"] =
            json!("browser_script");

        let mut invalid_expression_ref = canonical_workflow_definition("leave_request");
        invalid_expression_ref["graph"]["nodes"][3]["config"]["expression"]["left"]["ref"] =
            json!("trigger.raw_table");

        let mut invalid_branch_when = canonical_workflow_definition("leave_request");
        invalid_branch_when["graph"]["nodes"][3]["config"]["branches"][0]["when"] =
            json!("javascript:approved");

        let mut invalid_default_port = canonical_workflow_definition("leave_request");
        invalid_default_port["graph"]["nodes"][3]["config"]["default_port"] =
            json!("trigger.raw_table");

        let mut undeclared_branch_port = canonical_workflow_definition("leave_request");
        undeclared_branch_port["graph"]["nodes"][3]["output_ports"]
            .as_array_mut()
            .ok_or_else(|| "branch output ports fixture must be an array".to_owned())?
            .push(json!({
                "key": "browser_defined",
                "direction": "output",
                "type": "flow.branch",
                "required": false,
                "cardinality": "one",
                "label": "Browser-defined"
            }));

        let cases = [
            ("invalid_condition_expression", invalid_expression_op),
            ("invalid_condition_expression", invalid_expression_ref),
            ("invalid_condition_branch", invalid_branch_when),
            ("invalid_condition_default", invalid_default_port),
            ("invalid_condition_branch", undeclared_branch_port),
        ];

        for (expected_code, definition) in cases {
            let err = match normalize_create_request(create_request(definition, "leave_request")) {
                Ok(_) => return Err("unsafe condition.branch config must fail closed".to_owned()),
                Err(err) => err,
            };
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                err.message.contains(expected_code),
                "expected validation message to contain {expected_code}, got {}",
                err.message
            );
        }

        Ok(())
    }

    #[test]
    fn create_rejects_browser_defined_object_scope_and_update_handles() -> Result<(), String> {
        let mut trigger_object_mismatch = canonical_workflow_definition("leave_request");
        trigger_object_mismatch["graph"]["nodes"][0]["config"]["source"]["object_type"] =
            json!("raw_table");

        let mut trigger_scope_escape = canonical_workflow_definition("leave_request");
        trigger_scope_escape["graph"]["nodes"][0]["config"]["source"]["scope"] = json!("browser");

        let mut form_object_mismatch = canonical_workflow_definition("leave_request");
        form_object_mismatch["graph"]["nodes"][1]["config"]["fields"][0]["object_type"] =
            json!("raw_table");

        let mut raw_action_id = canonical_workflow_definition("leave_request");
        raw_action_id["graph"]["nodes"][4]["config"]["action_id"] = json!("raw_table.update");

        let mut raw_policy = canonical_workflow_definition("leave_request");
        raw_policy["graph"]["nodes"][4]["config"]["requires_policy"] = json!("raw_table.update");

        let mut raw_target = canonical_workflow_definition("leave_request");
        raw_target["graph"]["nodes"][4]["config"]["target"]["from"] = json!("trigger.raw_table");

        let mut raw_input_handle = canonical_workflow_definition("leave_request");
        raw_input_handle["graph"]["nodes"][4]["config"]["input"]["updated_by"]["from"] =
            json!("form.browser_actor");

        let cases = [
            ("object_type_mismatch", trigger_object_mismatch),
            ("trigger_source", trigger_scope_escape),
            ("object_type_mismatch", form_object_mismatch),
            ("object_action_not_allowlisted", raw_action_id),
            ("object_action_not_allowlisted", raw_policy),
            ("invalid_object_update_target", raw_target),
            ("invalid_object_update_input", raw_input_handle),
        ];

        for (expected_code, definition) in cases {
            let err = match normalize_create_request(create_request(definition, "leave_request")) {
                Ok(_) => {
                    return Err("browser-defined object/action scope must fail closed".to_owned());
                }
                Err(err) => err,
            };
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                err.message.contains(expected_code),
                "expected validation message to contain {expected_code}, got {}",
                err.message
            );
        }

        Ok(())
    }

    #[test]
    fn accepts_leave_and_catalog_canonical_workflow_templates() -> Result<(), String> {
        let mut object_types = vec!["leave_request"];
        object_types.extend(
            WORKFLOW_TEMPLATES
                .iter()
                .map(|template| template.object_type),
        );

        for object_type in object_types {
            normalize_create_request(create_request(
                canonical_workflow_definition(object_type),
                object_type,
            ))
            .map_err(|err| err.message)?;
        }

        Ok(())
    }

    #[test]
    fn publish_validation_blocks_invalid_canonical_workflow_graphs() {
        let mut invalid_definition = canonical_workflow_definition("leave_request");
        invalid_definition["graph"]["edges"][0]["to_port"] = json!("missing_port");
        let row = workflow_row(invalid_definition, "leave_request");

        let findings = validate_publishable(&row);

        assert!(
            findings
                .iter()
                .any(|finding| finding.code == "invalid_edge_endpoint"),
            "expected invalid_edge_endpoint blocker, got {findings:?}"
        );
    }

    #[test]
    fn publish_validation_messages_include_stable_codes() {
        let mut invalid_definition = canonical_workflow_definition("leave_request");
        invalid_definition["graph"]["edges"][0]["to_port"] = json!("missing_port");
        let row = workflow_row(invalid_definition, "leave_request");

        let message = format_publish_findings(validate_publishable(&row));

        assert!(message.contains("invalid_edge_endpoint:"));
        assert!(!message.contains("node-trigger"));
        assert!(!message.contains("missing_port"));
    }

    #[test]
    fn publish_validation_messages_hide_action_allowlist_payload_values() {
        let mut row = workflow_row(
            canonical_workflow_definition("leave_request"),
            "leave_request",
        );
        row.action_allowlist = vec![json!({
            "connector_key": "external.random",
            "action_key": "post_secret"
        })];

        let message = format_publish_findings(validate_publishable(&row));

        assert!(message.contains("invalid_action_allowlist:"));
        assert!(!message.contains("external.random"));
        assert!(!message.contains("post_secret"));
    }

    fn policy_decision_definition() -> Value {
        let mut definition = canonical_workflow_definition("equipment");
        definition["policy_decision"] = json!({
                "template_key": "equipment_location_access",
                "effect": "allow",
                "action": "maintenance:StartWorkOrder",
                "resource": { "type": "equipment", "id": "EQ-BOILER-17" },
                "context": {
                    "org_id": "org_demo_001",
                    "location_id": "loc_plant_2",
                    "subject_role": "MAINTENANCE_MANAGER",
                    "passkey_step_up_satisfied": true
                },
                "scope": {
                    "org_id": "org_demo_001",
                    "location_id": "loc_plant_2"
                },
                "requirements": {
                    "passkey_step_up": true,
                    "audit_event": "workflow_definition.publish"
                }
        });
        definition
    }

    fn create_request(definition: Value, object_type: &str) -> CreateWorkflowDefinitionRequest {
        CreateWorkflowDefinitionRequest {
            workflow_key: format!("{object_type}.approval"),
            display_name: format!("{object_type} approval"),
            object_type: object_type.to_owned(),
            definition,
            approval_line: vec![],
            payment_line: vec![],
            notification_rules: vec![],
            action_allowlist: vec![json!({
                "connector_key": "internal.notifications",
                "action_key": "send_push"
            })],
            required_approval_line: false,
            required_payment_line: false,
        }
    }

    fn workflow_row(definition: Value, object_type: &str) -> WorkflowVersionRow {
        WorkflowVersionRow {
            definition_id: Uuid::new_v4(),
            workflow_key: format!("{object_type}.approval"),
            display_name: format!("{object_type} approval"),
            object_type: object_type.to_owned(),
            status: "DRAFT".to_owned(),
            latest_version: 1,
            active_version: None,
            definition,
            approval_line: vec![],
            payment_line: vec![],
            notification_rules: vec![],
            action_allowlist: vec![json!({
                "connector_key": "internal.notifications",
                "action_key": "send_push"
            })],
            required_approval_line: false,
            required_payment_line: false,
            pending_version: None,
            pending_staged_by: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    fn canonical_workflow_definition(object_type: &str) -> Value {
        json!({
            "schema_version": "workflow.definition.v1",
            "metadata": {
                "name": format!("{object_type} approval"),
                "description": "Server validation fixture for a canonical no-code workflow.",
                "owner_scope": { "type": "org" },
                "object_type": object_type,
                "sensitivity": "summary_only",
                "tags": [object_type, "approval"],
                "locale": "ko-KR"
            },
            "graph": {
                "nodes": [
                    node("node-trigger", &format!("trigger.{object_type}.submitted"), "trigger.form_submission", "Submitted", vec![], vec![output_port("submitted", "flow.next", "Submitted")], json!({
                        "type": "trigger.form_submission",
                        "source": { "object_type": object_type, "event": "submitted", "scope": "org" },
                        "actor": { "required_policy": format!("{object_type}.submit") },
                        "idempotency": { "key_template": format!("{object_type}:{{object_id}}:submitted:{{version}}") }
                    })),
                    node("node-form", &format!("form.{object_type}"), "form.input", "Review form", vec![input_port("in", "flow.next", "In")], vec![output_port("completed", "flow.next", "Completed")], json!({
                        "type": "form.input",
                        "fields": [{
                            "key": format!("{object_type}_id"),
                            "label": "Request",
                            "field_type": "object_ref",
                            "object_type": object_type,
                            "required": true,
                            "sensitivity": "summary_only"
                        }],
                        "submit_label": "Submit"
                    })),
                    node("node-approval", &format!("task.{object_type}.approval"), "task.approval", "Approval", vec![input_port("in", "flow.next", "In")], vec![output_port("decision", "flow.next", "Decision")], json!({
                        "type": "task.approval",
                        "assignee_rule": { "kind": "role", "subject_field": format!("{object_type}_id"), "fallback_role": "operations.manager" },
                        "decision_options": ["approve", "reject", "request_change"],
                        "requires_comment_on": ["reject"],
                        "requires_evidence": false,
                        "prevent_self_approval": true,
                        "sla": { "duration": "P2D", "escalate_to": "operations.director" },
                        "requires_passkey_step_up": false,
                        "policy": [format!("approval_request.approve.{object_type}")]
                    })),
                    node("node-condition", &format!("condition.{object_type}.approval_result"), "condition.branch", "Approval result", vec![input_port("in", "flow.next", "Decision")], vec![branch_port("approved", "Approved"), branch_port("rejected", "Rejected")], json!({
                        "type": "condition.branch",
                        "expression": { "op": "equals", "left": { "ref": "approval.result" }, "right": "approved" },
                        "branches": [
                            { "port": "approved", "label": "Approved", "when": "true" },
                            { "port": "rejected", "label": "Rejected", "when": "false" }
                        ],
                        "default_port": "rejected"
                    })),
                    action_update_node(object_type, "approved"),
                    notification_node(object_type, "approved"),
                    audit_node(object_type, "approved"),
                    end_node("approved"),
                    action_update_node(object_type, "rejected"),
                    notification_node(object_type, "rejected"),
                    audit_node(object_type, "rejected"),
                    end_node("rejected")
                ],
                "edges": [
                    edge("edge-trigger-form", "node-trigger", "submitted", "node-form", "in", "control"),
                    edge("edge-form-approval", "node-form", "completed", "node-approval", "in", "control"),
                    edge("edge-approval-condition", "node-approval", "decision", "node-condition", "in", "control"),
                    edge("edge-condition-approved-update", "node-condition", "approved", "node-approved-update", "in", "decision"),
                    edge("edge-approved-update-notify", "node-approved-update", "done", "node-approved-notify", "in", "control"),
                    edge("edge-approved-notify-audit", "node-approved-notify", "done", "node-approved-audit", "in", "control"),
                    edge("edge-approved-audit-end", "node-approved-audit", "done", "node-end-approved", "in", "control"),
                    edge("edge-condition-rejected-update", "node-condition", "rejected", "node-rejected-update", "in", "decision"),
                    edge("edge-rejected-update-notify", "node-rejected-update", "done", "node-rejected-notify", "in", "control"),
                    edge("edge-rejected-notify-audit", "node-rejected-notify", "done", "node-rejected-audit", "in", "control"),
                    edge("edge-rejected-audit-end", "node-rejected-audit", "done", "node-end-rejected", "in", "control")
                ],
                "variables": [],
                "simulation_cases": [{ "key": "happy_path", "label": "Happy path" }]
            },
            "canvas": { "layout_version": "workflow.canvas.v1", "nodes": {}, "viewport": { "x": 0, "y": 0, "zoom": 1 } },
            "validation": { "last_result": "valid", "last_validated_at": null, "compiler_version": null }
        })
    }

    fn action_update_node(object_type: &str, status: &str) -> Value {
        node(
            &format!("node-{status}-update"),
            &format!("action.{object_type}.{status}_status"),
            "action.object_update",
            &format!("Set status {status}"),
            vec![input_port("in", "flow.next", "In")],
            vec![output_port("done", "flow.next", "Done")],
            json!({
                "type": "action.object_update",
                "action_id": format!("{object_type}.update_status"),
                "target": { "from": "trigger.object_ref" },
                "input": { "status": status, "updated_by": { "from": "approval.actor_id" }, "updated_at": { "from": "system.now" } },
                "idempotency": { "key_template": format!("{{run_id}}:{{node_key}}:{object_type}.update_status.{status}") },
                "requires_policy": format!("{object_type}.update_status")
            }),
        )
    }

    fn notification_node(object_type: &str, status: &str) -> Value {
        node(
            &format!("node-{status}-notify"),
            &format!("action.{object_type}.notify_{status}"),
            "action.notification",
            &format!("Notify {status}"),
            vec![input_port("in", "flow.next", "In")],
            vec![output_port("done", "flow.next", "Done")],
            json!({
                "type": "action.notification",
                "connector_key": "internal.notifications",
                "action_key": "send_push",
                "recipient": { "kind": "requester" },
                "template_key": format!("{object_type}.{status}"),
                "redaction": "summary_only",
                "link": { "object_ref": "trigger.object_ref" }
            }),
        )
    }

    fn audit_node(object_type: &str, status: &str) -> Value {
        node(
            &format!("node-{status}-audit"),
            &format!("action.{object_type}.audit_{status}"),
            "action.audit_append",
            &format!("Audit {status}"),
            vec![input_port("in", "flow.next", "In")],
            vec![output_port("done", "flow.next", "Done")],
            json!({
                "type": "action.audit_append",
                "event_key": format!("{object_type}.workflow.{status}"),
                "summary_template": format!("{object_type} workflow completed with {status}."),
                "redaction": "summary_only"
            }),
        )
    }

    fn end_node(status: &str) -> Value {
        node(
            &format!("node-end-{status}"),
            &format!("end.{status}"),
            "end.state",
            &format!("{status} end"),
            vec![input_port("in", "flow.terminal", "In")],
            vec![],
            json!({ "type": "end.state", "status": status }),
        )
    }

    fn node(
        id: &str,
        key: &str,
        node_type: &str,
        label: &str,
        input_ports: Vec<Value>,
        output_ports: Vec<Value>,
        config: Value,
    ) -> Value {
        json!({
            "id": id,
            "key": key,
            "type": node_type,
            "label": label,
            "version": 1,
            "input_ports": input_ports,
            "output_ports": output_ports,
            "config": config,
            "policy": [],
            "data_sensitivity": "summary_only",
            "execution": {}
        })
    }

    fn input_port(key: &str, port_type: &str, label: &str) -> Value {
        port(key, "input", port_type, label)
    }

    fn output_port(key: &str, port_type: &str, label: &str) -> Value {
        port(key, "output", port_type, label)
    }

    fn branch_port(key: &str, label: &str) -> Value {
        port(key, "output", "flow.branch", label)
    }

    fn port(key: &str, direction: &str, port_type: &str, label: &str) -> Value {
        json!({ "key": key, "direction": direction, "type": port_type, "required": true, "cardinality": "one", "label": label })
    }

    fn edge(
        id: &str,
        from_node_id: &str,
        from_port: &str,
        to_node_id: &str,
        to_port: &str,
        kind: &str,
    ) -> Value {
        json!({ "id": id, "from_node_id": from_node_id, "from_port": from_port, "to_node_id": to_node_id, "to_port": to_port, "kind": kind })
    }

    fn policy_row(definition: Value) -> WorkflowVersionRow {
        WorkflowVersionRow {
            definition_id: Uuid::new_v4(),
            workflow_key: "equipment.equipment_location_access_policy".to_owned(),
            display_name: "Equipment Location Access".to_owned(),
            object_type: "equipment".to_owned(),
            status: "DRAFT".to_owned(),
            latest_version: 1,
            active_version: None,
            definition,
            approval_line: vec![json!({
                "step_key": "manager",
                "approver_role": "MAINTENANCE_MANAGER",
                "required": true
            })],
            payment_line: vec![],
            notification_rules: vec![],
            action_allowlist: vec![json!({
                "connector_key": "internal.audit",
                "action_key": "append_timeline_event"
            })],
            required_approval_line: true,
            required_payment_line: false,
            pending_version: None,
            pending_staged_by: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn policy_decision_blocks_unsupported_templates() -> Result<(), String> {
        let mut definition = policy_decision_definition();
        definition["policy_decision"]["template_key"] = json!("approve_work_order");
        definition["policy_decision"]["action"] = json!("maintenance:ApproveWorkOrder");
        definition["policy_decision"]["resource"] = json!({ "type": "work_order", "id": "WO-17" });

        let err = match validate_definition_object(definition) {
            Ok(_) => return Err("unsupported policy template must fail closed".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains("equipment_location_access"));
        Ok(())
    }

    #[test]
    fn definition_schema_version_is_required() -> Result<(), String> {
        let err = match validate_definition_object(json!({ "trigger": "work_order.completed" })) {
            Ok(_) => return Err("missing schema_version must fail closed".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains("schema_version"));
        Ok(())
    }

    #[test]
    fn definition_schema_version_must_match_supported_version() -> Result<(), String> {
        let err = match validate_definition_object(json!({
            "schema_version": "workflow.definition.v0",
            "trigger": "work_order.completed"
        })) {
            Ok(_) => return Err("mismatched schema_version must fail closed".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.message.contains(WORKFLOW_DEFINITION_SCHEMA_VERSION));
        Ok(())
    }

    #[test]
    fn policy_decision_simulation_surfaces_cedar_pbac_tuple() {
        let simulation = simulation_for(&policy_row(policy_decision_definition()));

        assert_eq!(simulation.decision, "ready");
        assert!(simulation.findings.iter().any(|finding| {
            finding.code == "policy_decision_metadata"
                && finding.message.contains("maintenance:StartWorkOrder")
                && finding.message.contains("equipment")
                && finding.message.contains("subject_role")
        }));
    }

    #[test]
    fn policy_decision_metadata_requires_valid_schema() {
        let mut definition = policy_decision_definition();
        definition["schema_version"] = json!("workflow.definition.v0");

        let simulation = simulation_for(&policy_row(definition));

        assert_eq!(simulation.decision, "blocked");
        assert!(simulation.findings.iter().any(|finding| {
            finding.code == "schema_version" && finding.message.contains("schema_version")
        }));
        assert!(
            simulation
                .findings
                .iter()
                .all(|finding| finding.code != "policy_decision_metadata")
        );
    }

    #[test]
    fn simulation_surfaces_non_blocking_findings() {
        let mut row = policy_row(policy_decision_definition());
        row.action_allowlist = vec![];

        let simulation = simulation_for(&row);

        assert_eq!(simulation.decision, "ready");
        assert!(
            simulation
                .findings
                .iter()
                .any(|finding| finding.code == "empty_action_allowlist")
        );
    }

    #[test]
    fn policy_decision_missing_scope_blocks_publish() -> Result<(), String> {
        let mut definition = policy_decision_definition();
        definition["policy_decision"]
            .as_object_mut()
            .ok_or_else(|| "policy_decision fixture must be an object".to_owned())?
            .remove("scope");

        let findings = validate_publishable(&policy_row(definition));

        assert!(findings.iter().any(|finding| {
            finding.code == "invalid_policy_decision" && finding.message.contains("scope")
        }));
        Ok(())
    }

    #[test]
    fn draft_update_merges_partial_payload_without_mutating_identity() -> Result<(), String> {
        let current = policy_row(policy_decision_definition());
        let next = apply_draft_update(
            &current,
            NormalizedWorkflowDefinitionUpdate {
                display_name: Some("Updated policy draft".to_owned()),
                definition: None,
                approval_line: Some(vec![json!({
                    "step_key": "owner",
                    "approver_role": "MAINTENANCE_MANAGER",
                    "required": true
                })]),
                payment_line: None,
                notification_rules: Some(vec![]),
                action_allowlist: None,
                required_approval_line: Some(false),
                required_payment_line: None,
            },
        )
        .map_err(|err| err.message)?;

        assert_eq!(next.definition_id, current.definition_id);
        assert_eq!(next.workflow_key, current.workflow_key);
        assert_eq!(next.object_type, current.object_type);
        assert_eq!(next.display_name, "Updated policy draft");
        assert_eq!(next.approval_line.len(), 1);
        assert!(next.notification_rules.is_empty());
        assert!(!next.required_approval_line);
        assert_eq!(next.definition, current.definition);
        Ok(())
    }

    #[test]
    fn draft_update_requires_draft_status() -> Result<(), String> {
        let mut current = policy_row(policy_decision_definition());
        current.status = "ACTIVE".to_owned();

        let err = match apply_draft_update(
            &current,
            NormalizedWorkflowDefinitionUpdate {
                display_name: Some("Cannot edit".to_owned()),
                definition: None,
                approval_line: None,
                payment_line: None,
                notification_rules: None,
                action_allowlist: None,
                required_approval_line: None,
                required_payment_line: None,
            },
        ) {
            Ok(_) => return Err("published definitions must not be editable drafts".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");
        Ok(())
    }

    #[test]
    fn draft_update_rejects_empty_payload() -> Result<(), String> {
        let err = match normalize_update_request(UpdateWorkflowDefinitionRequest {
            display_name: None,
            definition: None,
            approval_line: None,
            payment_line: None,
            notification_rules: None,
            action_allowlist: None,
            required_approval_line: None,
            required_payment_line: None,
        }) {
            Ok(_) => return Err("empty updates must not append no-op draft versions".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "validation");
        Ok(())
    }

    #[test]
    fn retired_definitions_cannot_take_sensitive_lifecycle_actions() -> Result<(), String> {
        let mut current = policy_row(policy_decision_definition());
        current.status = "RETIRED".to_owned();

        let err = match ensure_not_retired(&current) {
            Ok(()) => return Err("retired definitions must fail closed".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");
        Ok(())
    }
}
