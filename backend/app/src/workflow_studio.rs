use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, TraceContext, UserId,
};
use mnt_platform_auth::{JwtVerifier, PasskeyAuthenticationCredential, PasskeyService};
use mnt_platform_authz::{Action, AuthorizationAuditEvent, Feature, Principal, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_workflow_domain::{
    FinalizeWaitingTaskCommand, PostFinalizationRejectionCommand, RunStatus, TriggerType,
    WaitingTaskStatus, WorkflowRuntimePort,
};
use mnt_workflow_runtime::{
    AuditContext, ExecGraph, FinalizeMode, FinalizePolicyRequest, NodeKind, StartRunRequest,
    WAITING_COMPLETION_DOMAIN, build_guard_request, drive_from, enforce_finalize_policy, guard,
    start_run, workflow_coexistence_entry,
};
use mnt_workflow_runtime_adapter_postgres::{
    ClaimWaitingTaskCommand, DecideWaitingTaskCommand, PgWorkflowRuntimeStore, RunListFilter,
    RunListItem, TaskDecision, WaitingTaskListFilter, WaitingTaskListItem,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::str::FromStr;
use time::OffsetDateTime;
use uuid::Uuid;

pub const WORKFLOW_STUDIO_CATALOG_PATH: &str = "/api/v1/workflow-studio/catalog";
pub const WORKFLOW_STUDIO_DEFINITIONS_PATH: &str = "/api/v1/workflow-studio/definitions";
pub const WORKFLOW_STUDIO_DEFINITION_PATH_TEMPLATE: &str =
    "/api/v1/workflow-studio/definitions/{id}";
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
pub const WORKFLOW_TASK_FINALIZE_PATH_TEMPLATE: &str = "/api/v1/workflow-tasks/{task_id}/finalize";
pub const WORKFLOW_RUN_POST_FINALIZATION_REJECTION_PATH_TEMPLATE: &str =
    "/api/v1/workflow-runs/{run_id}/post-finalization-rejection";
pub const WORKFLOW_RUNS_PATH: &str = "/api/v1/workflow-runs";
pub const WORKFLOW_RUNS_MINE_PATH: &str = "/api/v1/workflow-runs/mine";
pub const WORKFLOW_TASKS_PATH: &str = "/api/v1/workflow-tasks";
pub const WORKFLOW_TASK_CLAIM_PATH_TEMPLATE: &str = "/api/v1/workflow-tasks/{task_id}/claim";
pub const WORKFLOW_TASK_DECIDE_PATH_TEMPLATE: &str = "/api/v1/workflow-tasks/{task_id}/decide";

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

#[allow(dead_code)]
const APPROVAL_TEMPLATES: &[ApprovalTemplate] = &[
    ApprovalTemplate {
        key: "ot",
        workflow_key: "approval.ot",
        reason_enum: &["업무 마감", "긴급 대응", "정기 점검", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "work_order",
            required: false,
        }],
        default_line: &["team_lead_reviewer", "hr_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "leave",
        workflow_key: "approval.leave",
        reason_enum: &["개인 사유", "병가", "경조", "가족 돌봄", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "attendance_schedule",
            required: true,
        }],
        default_line: &["manager_approver"],
        receipt_required: true,
    },
    ApprovalTemplate {
        key: "expense",
        workflow_key: "approval.expense",
        reason_enum: &["교통", "식대", "숙박", "소모품", "접대", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "contract",
            required: false,
        }],
        default_line: &["team_lead_reviewer", "finance_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "sub",
        workflow_key: "approval.sub",
        reason_enum: &["결원 대체", "휴가 대체", "긴급 투입", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "site",
            required: false,
        }],
        default_line: &["team_lead_reviewer", "hr_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "purchase",
        workflow_key: "approval.purchase",
        reason_enum: &["자재", "비품", "장비", "수리", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "asset_or_inventory",
            required: false,
        }],
        default_line: &["team_lead_reviewer", "finance_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "benefit",
        workflow_key: "approval.benefit",
        reason_enum: &["경조", "자기계발", "건강검진", "포상", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "payee",
            required: true,
        }],
        default_line: &["team_lead_reviewer", "hr_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "reimburse",
        workflow_key: "approval.reimburse",
        reason_enum: &["교통", "식대", "숙박", "소모품", "접대", "기타"],
        linked_objects: &[ApprovalLinkedObject {
            kind: "project_or_work",
            required: false,
        }],
        default_line: &["team_lead_reviewer", "finance_approver"],
        receipt_required: false,
    },
    ApprovalTemplate {
        key: "general",
        workflow_key: "approval.general",
        reason_enum: &["보고", "요청", "건의", "기타"],
        linked_objects: &[],
        default_line: &["team_lead_reviewer", "division_approver"],
        receipt_required: false,
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
        .route(WORKFLOW_TASK_FINALIZE_PATH_TEMPLATE, post(finalize_task))
        .route(
            WORKFLOW_RUN_POST_FINALIZATION_REJECTION_PATH_TEMPLATE,
            post(create_post_finalization_rejection),
        )
        .route(WORKFLOW_RUNS_PATH, post(start_workflow_run))
        .route(WORKFLOW_RUNS_MINE_PATH, get(list_my_workflow_runs))
        .route(WORKFLOW_TASKS_PATH, get(list_workflow_tasks))
        .route(WORKFLOW_TASK_CLAIM_PATH_TEMPLATE, post(claim_workflow_task))
        .route(
            WORKFLOW_TASK_DECIDE_PATH_TEMPLATE,
            post(decide_workflow_task),
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

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct ApprovalTemplate {
    key: &'static str,
    workflow_key: &'static str,
    reason_enum: &'static [&'static str],
    linked_objects: &'static [ApprovalLinkedObject],
    default_line: &'static [&'static str],
    receipt_required: bool,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
struct ApprovalLinkedObject {
    kind: &'static str,
    required: bool,
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

#[derive(Debug, Deserialize)]
struct FinalizeWorkflowTaskRequest {
    mode: FinalizeWorkflowTaskMode,
    #[serde(default)]
    reason: Option<String>,
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FinalizeWorkflowTaskMode {
    Author,
    Delegate,
}

impl FinalizeWorkflowTaskMode {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Delegate => "delegate",
        }
    }

    const fn policy_mode(&self) -> FinalizeMode {
        match self {
            Self::Author => FinalizeMode::Author,
            Self::Delegate => FinalizeMode::Delegate,
        }
    }
}

#[derive(Debug, Serialize)]
struct FinalizeWorkflowTaskResponse {
    task: FinalizedTaskResponse,
    run: FinalizedRunResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_ref: Option<Value>,
}

#[derive(Debug, Serialize)]
struct FinalizedTaskResponse {
    id: Uuid,
    run_id: Uuid,
    status: String,
    completed_by: Option<UserId>,
    decision_payload: Value,
}

#[derive(Debug, Serialize)]
struct FinalizedRunResponse {
    id: Uuid,
    status: String,
}

#[derive(Debug, Deserialize)]
struct PostFinalizationRejectionRequest {
    reason: String,
    idempotency_key: String,
}

#[derive(Debug, Serialize)]
struct PostFinalizationRejectionResponse {
    compensation: PostFinalizationRejectionDocumentResponse,
    run: FinalizedRunResponse,
}

#[derive(Debug, Serialize)]
struct PostFinalizationRejectionDocumentResponse {
    id: Uuid,
    original_run_id: Uuid,
    reason: String,
    created_by: UserId,
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

async fn finalize_task(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(task_id): Path<Uuid>,
    Json(request): Json<FinalizeWorkflowTaskRequest>,
) -> Result<Json<FinalizeWorkflowTaskResponse>, WorkflowStudioError> {
    let idempotency_key = request.idempotency_key.trim();
    if idempotency_key.len() < 16 {
        return Err(WorkflowStudioError::validation(
            "idempotency_key must be at least 16 characters",
        ));
    }

    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let context = store
        .load_finalize_waiting_task(principal.org_id, task_id)
        .await?
        .ok_or_else(|| KernelError::not_found("workflow task not found"))?;
    if context.waiting_key != "finalize.author"
        && context.required_policy.as_deref() != Some("approval_finalize")
    {
        return Err(WorkflowStudioError::validation(
            "workflow task is not a finalization task",
        ));
    }

    let branch = guard_branch(&principal);
    let resource_type = context.object_type.as_deref().unwrap_or("workflow_run");
    let resource_id = context
        .object_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| context.run_id.to_string());
    let policy = enforce_finalize_policy(FinalizePolicyRequest {
        mode: request.mode.policy_mode(),
        reason: request.reason.as_deref(),
        required_policy: context.required_policy.as_deref(),
        principal: &principal,
        org: principal.org_id,
        branch,
        resource_type,
        resource_id,
        initiated_by: context.initiated_by,
    })?;

    let mut audits = Vec::new();
    if let Some(guard_audit) = policy.guard_audit {
        audits.push(shadow_audit_event(
            &guard_audit,
            principal.user_id,
            principal.org_id,
            task_id,
        )?);
    }

    let finalized = store
        .finalize_waiting_task(
            principal.org_id,
            FinalizeWaitingTaskCommand {
                task_id,
                actor: principal.user_id,
                idempotency_key: idempotency_key.to_owned(),
                mode: request.mode.as_str().to_owned(),
                delegated_reason: policy.delegated_reason,
                transition_audits: audits,
            },
        )
        .await?;

    record_workflow_studio_request("task_finalize", "success");
    Ok(Json(FinalizeWorkflowTaskResponse {
        task: FinalizedTaskResponse {
            id: finalized.task_id,
            run_id: finalized.run_id,
            status: finalized.status.as_db_str().to_owned(),
            completed_by: finalized.completed_by,
            decision_payload: finalized.decision_payload,
        },
        run: FinalizedRunResponse {
            id: finalized.run_id,
            status: finalized.run_status.as_db_str().to_owned(),
        },
        archive_ref: None,
    }))
}

/// Post-finalization rejection: reverse an already-finalized run with a
/// compensating document.
///
/// AUTHORITY IS ORG-WIDE BY DESIGN (security M4, DESIGN §2): the guard is
/// [`Feature::ApprovalFinalize`] with no branch/object narrowing, so an
/// 감사·컴플라이언스·CEO principal holding that feature may compensate ANY finalized
/// run across the tenant. This is the charter's reversal authority — a documented
/// decision, not a missing scope check. Narrowing it would break the
/// audit/compliance reversal path.
async fn create_post_finalization_rejection(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    Json(request): Json<PostFinalizationRejectionRequest>,
) -> Result<Json<PostFinalizationRejectionResponse>, WorkflowStudioError> {
    let idempotency_key = request.idempotency_key.trim();
    if idempotency_key.len() < 16 {
        return Err(WorkflowStudioError::validation(
            "idempotency_key must be at least 16 characters",
        ));
    }
    let reason = request.reason.trim();
    if reason.is_empty() {
        return Err(WorkflowStudioError::validation(
            "post-finalization rejection requires a non-empty reason",
        ));
    }

    let branch = guard_branch(&principal);
    let authz_request = build_guard_request(
        &principal,
        Feature::ApprovalFinalize.as_str(),
        principal.org_id,
        branch,
        "workflow_run",
        &run_id.to_string(),
        WAITING_COMPLETION_DOMAIN,
    )
    .map_err(|_| {
        WorkflowStudioError::from(KernelError::forbidden(
            "post-finalization rejection policy denied",
        ))
    })?;
    let entry = workflow_coexistence_entry(
        "workflow.waiting_task.post_finalization_rejection",
        WAITING_COMPLETION_DOMAIN,
        Feature::ApprovalFinalize,
        "workflow_run",
    );
    let guard_outcome = guard(&authz_request, &entry);
    if !guard_outcome.is_allowed() {
        return Err(WorkflowStudioError::from(KernelError::forbidden(
            "post-finalization rejection policy denied",
        )));
    }

    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let compensation = store
        .create_post_finalization_rejection(
            principal.org_id,
            PostFinalizationRejectionCommand {
                original_run_id: run_id,
                actor: principal.user_id,
                reason: reason.to_owned(),
                idempotency_key: idempotency_key.to_owned(),
                transition_audits: vec![shadow_audit_event_for(
                    &guard_outcome.audit,
                    principal.user_id,
                    principal.org_id,
                    "workflow_run",
                    run_id,
                )?],
            },
        )
        .await?;

    record_workflow_studio_request("post_finalization_rejection", "success");
    Ok(Json(PostFinalizationRejectionResponse {
        compensation: PostFinalizationRejectionDocumentResponse {
            id: compensation.id,
            original_run_id: compensation.original_run_id,
            reason: compensation.reason,
            created_by: compensation.created_by,
        },
        run: FinalizedRunResponse {
            id: compensation.original_run_id,
            status: compensation.run_status.as_db_str().to_owned(),
        },
    }))
}

// ===========================================================================
// Instance / task REST surface (engine-gen spike §"Instance/Task REST Surface").
// ===========================================================================

#[derive(Debug, Deserialize)]
struct StartWorkflowRunRequest {
    definition_id: Uuid,
    #[serde(default)]
    definition_version: Option<i32>,
    #[serde(default)]
    object_type: Option<String>,
    #[serde(default)]
    object_id: Option<Uuid>,
    trigger_type: TriggerType,
    idempotency_key: String,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default = "empty_object")]
    input_payload: Value,
    #[serde(default = "empty_object")]
    context_payload: Value,
}

#[derive(Debug, Serialize)]
struct StartWorkflowRunResponse {
    run: RunSummaryResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_task: Option<TaskSummaryResponse>,
}

#[derive(Debug, Serialize)]
struct RunSummaryResponse {
    id: Uuid,
    status: String,
    definition_id: Uuid,
    definition_version: i32,
    object_type: Option<String>,
    object_id: Option<Uuid>,
    initiated_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    started_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct TaskSummaryResponse {
    task_id: Uuid,
    run_id: Uuid,
    waiting_key: String,
    title: String,
    assignee_role_key: Option<String>,
    required_policy: Option<String>,
    object_type: Option<String>,
    object_id: Option<Uuid>,
    status: String,
    claimed_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    due_at: Option<OffsetDateTime>,
    form_payload: Value,
}

impl From<WaitingTaskListItem> for TaskSummaryResponse {
    fn from(item: WaitingTaskListItem) -> Self {
        Self {
            task_id: item.task_id,
            run_id: item.run_id,
            waiting_key: item.waiting_key,
            title: item.title,
            assignee_role_key: item.assignee_role_key,
            required_policy: item.required_policy,
            object_type: item.object_type,
            object_id: item.object_id,
            status: item.status.as_db_str().to_owned(),
            claimed_by: item.claimed_by,
            due_at: item.due_at,
            form_payload: item.form_payload,
        }
    }
}

#[derive(Debug, Serialize)]
struct WorkflowTaskListResponse {
    items: Vec<TaskSummaryResponse>,
}

#[derive(Debug, Deserialize)]
struct TaskListQuery {
    #[serde(default)]
    role_key: Option<String>,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunListResponse {
    items: Vec<RunListItemResponse>,
}

#[derive(Debug, Serialize)]
struct RunListItemResponse {
    run_id: Uuid,
    status: String,
    definition_id: Uuid,
    definition_version: i32,
    object_type: Option<String>,
    object_id: Option<Uuid>,
    initiated_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    started_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

impl From<RunListItem> for RunListItemResponse {
    fn from(item: RunListItem) -> Self {
        Self {
            run_id: item.run_id,
            status: item.status.as_db_str().to_owned(),
            definition_id: item.definition_id,
            definition_version: item.definition_version,
            object_type: item.object_type,
            object_id: item.object_id,
            initiated_by: item.initiated_by,
            started_at: item.started_at,
            updated_at: item.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RunListQuery {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    object_type: Option<String>,
    // `q` (free-text search): case-insensitive substring match over the submission
    // row's human-readable content (object_type + input_payload). Applied inside the
    // org-scoped, initiator-scoped query — it only ever narrows, never widens.
    #[serde(default)]
    q: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimWorkflowTaskRequest {
    idempotency_key: String,
}

#[derive(Debug, Serialize)]
struct ClaimTaskResponse {
    task: ClaimedTaskResponse,
}

#[derive(Debug, Serialize)]
struct ClaimedTaskResponse {
    task_id: Uuid,
    run_id: Uuid,
    status: String,
    claimed_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    claimed_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
struct DecideWorkflowTaskRequest {
    decision: DecisionRequest,
    #[serde(default)]
    comment: Option<String>,
    idempotency_key: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DecisionRequest {
    Approve,
    Reject,
    Return,
}

impl From<DecisionRequest> for TaskDecision {
    fn from(value: DecisionRequest) -> Self {
        match value {
            DecisionRequest::Approve => Self::Approve,
            DecisionRequest::Reject => Self::Reject,
            DecisionRequest::Return => Self::Return,
        }
    }
}

#[derive(Debug, Serialize)]
struct DecideTaskResponse {
    task: DecidedTaskResponse,
    run: FinalizedRunResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_task: Option<TaskSummaryResponse>,
}

#[derive(Debug, Serialize)]
struct DecidedTaskResponse {
    task_id: Uuid,
    run_id: Uuid,
    status: String,
    decision_payload: Value,
}

/// Map an approval `required_policy` string to a canonical legacy `Feature` key so
/// the guard is well-defined without extending the frozen legacy permission matrix.
/// `approval_review`/`approval_decide` reuse `completion_review`; the closeout
/// policies reuse `approval_finalize`. Any other value must already be a real
/// `Feature` key, else the caller treats it as a deny (fail closed).
fn guard_policy(required_policy: &str) -> Option<String> {
    match required_policy {
        "approval_review" | "approval_decide" => Some("completion_review".to_owned()),
        "approval_finalize" | "approval_receipt" => Some("approval_finalize".to_owned()),
        other => Feature::from_str(other).ok().map(|_| other.to_owned()),
    }
}

/// Serialized-size ceiling for a caller-supplied run payload (security M2). 64 KiB
/// is far above any legitimate approval input; over it is a 422.
const MAX_RUN_PAYLOAD_BYTES: usize = 64 * 1024;

/// Reject an oversize `input_payload`/`context_payload` (security M2) with a 422.
fn check_payload_size(field: &str, payload: &Value) -> Result<(), WorkflowStudioError> {
    // Cheap upper bound: serialize once and measure. Bounded by the axum body
    // limit already, but an explicit per-field cap keeps a single 64 KiB blob from
    // riding in as run state.
    let len = serde_json::to_vec(payload)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if len > MAX_RUN_PAYLOAD_BYTES {
        return Err(WorkflowStudioError::validation(format!(
            "{field} must be at most {MAX_RUN_PAYLOAD_BYTES} bytes serialized"
        )));
    }
    Ok(())
}

/// Fail-closed guard for the claim/decide action path (security H1, defense in
/// depth): a waiting task with no `required_policy` carries no authorization
/// boundary. Authoring now REQUIRES one (`validate_execution_graph`), so a
/// policy-less row can only be a legacy record — refuse to act on it with a 403
/// rather than fall through `guard_task_policy`'s ungated `Ok(None)` path (that
/// path is for self-service *run starts*, never for acting on an existing task).
fn require_task_authorization_boundary(
    required_policy: Option<&str>,
) -> Result<(), WorkflowStudioError> {
    if required_policy.is_none() {
        return Err(WorkflowStudioError::from(KernelError::forbidden(
            "task has no authorization boundary",
        )));
    }
    Ok(())
}

/// Legacy-enforce + Cedar-shadow guard for a task/run policy. Returns the shadow
/// audit event to fold into the mutation (`None` when the task carries no policy —
/// an ungated self-service step), or a 403 when the legacy contract denies.
#[allow(clippy::too_many_arguments)]
fn guard_task_policy(
    principal: &Principal,
    org: mnt_kernel_core::OrgId,
    branch: BranchId,
    required_policy: Option<&str>,
    resource_type: &str,
    resource_id: &str,
    action_id: &'static str,
    shadow_target_id: Uuid,
) -> Result<Option<AuditEvent>, WorkflowStudioError> {
    let Some(policy) = required_policy else {
        return Ok(None);
    };
    let feature_key = guard_policy(policy).ok_or_else(|| {
        WorkflowStudioError::from(KernelError::forbidden("workflow task policy is unknown"))
    })?;
    let feature = Feature::from_str(&feature_key).map_err(|_| {
        WorkflowStudioError::from(KernelError::forbidden("workflow task policy is unknown"))
    })?;
    let request = build_guard_request(
        principal,
        &feature_key,
        org,
        branch,
        resource_type,
        resource_id,
        WAITING_COMPLETION_DOMAIN,
    )
    .map_err(|_| {
        WorkflowStudioError::from(KernelError::forbidden("workflow task policy denied"))
    })?;
    let entry = workflow_coexistence_entry(
        action_id,
        WAITING_COMPLETION_DOMAIN,
        feature,
        resource_type.to_owned(),
    );
    let outcome = guard(&request, &entry);
    if !outcome.is_allowed() {
        return Err(WorkflowStudioError::from(KernelError::forbidden(
            "workflow task policy denied",
        )));
    }
    Ok(Some(shadow_audit_event(
        &outcome.audit,
        principal.user_id,
        org,
        shadow_target_id,
    )?))
}

/// The workflow authority role keys resolved through the legacy matrix (security
/// M3). All map to `completion_review` — the review/decide/approve tiers of the
/// approval and completion lines — so "holds this role key" reuses the SAME guard
/// `task_visible` runs, never a parallel role system.
const WORKFLOW_AUTHORITY_ROLE_KEYS: [&str; 4] =
    ["hr_reviewer", "manager_approver", "executive", "admin"];

/// How a principal can "hold" a human-task `assignee_role_key` (security M3).
enum RoleKeyKind {
    /// Held when the principal passes the guard for this legacy feature key —
    /// the same matrix guard `guard_policy`/`task_visible` already use.
    Authority(&'static str),
    /// Held only by the run's initiator (`workflow_runs.initiated_by == me`), a
    /// fact the feature matrix cannot express. The task still carries a broad
    /// policy (e.g. `approval_finalize`), so ownership — not policy — is the
    /// addressee boundary.
    Ownership,
}

/// Classify a human-task `assignee_role_key` (security M3). Authority keys reuse
/// the matrix guard; ownership keys bind to the run initiator. An unknown key is
/// held by no one (fail closed) — it surfaces only when claimed.
///
/// ponytail: `receipt_subject` has no per-user binding column yet
/// (`workflow_waiting_tasks.assignee_user_id` is never written on insert), so it
/// cannot be scoped to its subject — it is left unclassified (deny) until a
/// subject column exists. In-scope templates use only
/// hr_reviewer/manager_approver/initiator.
fn classify_role_key(role_key: &str) -> Option<RoleKeyKind> {
    if WORKFLOW_AUTHORITY_ROLE_KEYS.contains(&role_key) {
        return Some(RoleKeyKind::Authority("completion_review"));
    }
    match role_key {
        "initiator" => Some(RoleKeyKind::Ownership),
        _ => None,
    }
}

/// Whether the principal passes the legacy guard for a bare feature capability
/// (security M3), reusing the exact `build_guard_request`/`guard` path
/// `task_visible` uses — no concrete resource, since role membership is a
/// capability question, not a per-object one.
fn principal_holds_feature(
    principal: &Principal,
    org: mnt_kernel_core::OrgId,
    branch: BranchId,
    feature_key: &str,
) -> bool {
    let Ok(feature) = Feature::from_str(feature_key) else {
        return false;
    };
    let Ok(request) = build_guard_request(
        principal,
        feature_key,
        org,
        branch,
        "workflow_run",
        "role_membership",
        WAITING_COMPLETION_DOMAIN,
    ) else {
        return false;
    };
    let entry = workflow_coexistence_entry(
        "workflow.waiting_task.role_membership",
        WAITING_COMPLETION_DOMAIN,
        feature,
        "workflow_run".to_owned(),
    );
    guard(&request, &entry).is_allowed()
}

/// The authority role keys this principal holds (security M3), for the personal
/// inbox's OPEN-task filter (`assignee_role_key = ANY(...)`).
fn held_authority_role_keys(
    principal: &Principal,
    org: mnt_kernel_core::OrgId,
    branch: BranchId,
) -> Vec<String> {
    WORKFLOW_AUTHORITY_ROLE_KEYS
        .iter()
        .filter(|role_key| match classify_role_key(role_key) {
            Some(RoleKeyKind::Authority(feature)) => {
                principal_holds_feature(principal, org, branch, feature)
            }
            _ => false,
        })
        .map(|role_key| (*role_key).to_owned())
        .collect()
}

/// Whether the principal may see the group (`role_key=`) inbox for `role_key`
/// (security M3): an authority key requires the matrix guard; an ownership key has
/// no org-wide queue (the owner sees it via `assignee=me`); an unknown key is
/// denied. A false result is a deny-by-omission (200 empty), never a 403.
fn holds_group_inbox_role(
    principal: &Principal,
    org: mnt_kernel_core::OrgId,
    branch: BranchId,
    role_key: &str,
) -> bool {
    match classify_role_key(role_key) {
        Some(RoleKeyKind::Authority(feature)) => {
            principal_holds_feature(principal, org, branch, feature)
        }
        Some(RoleKeyKind::Ownership) | None => false,
    }
}

/// Read-only visibility check for the inbox listings: a policy-bearing row is
/// visible only when the legacy contract allows the principal (deny-by-omission —
/// forbidden rows are absent, never returned as 403). Rows with no policy are
/// visible (their `role_key`/`assignee` filter is the access boundary).
fn task_visible(
    principal: &Principal,
    org: mnt_kernel_core::OrgId,
    branch: BranchId,
    item: &WaitingTaskListItem,
) -> bool {
    // Ownership-held rows (e.g. the initiator's own finalize task) reach this
    // filter ONLY when the adapter SQL already bound them to the caller
    // (initiated_by/claimed_by). Author finalization is owner-checked, not
    // policy-gated (authz: ApprovalFinalize), so a low-privilege owner must not
    // be stripped here by the policy layer (security M3).
    if item
        .assignee_role_key
        .as_deref()
        .and_then(classify_role_key)
        .is_some_and(|kind| matches!(kind, RoleKeyKind::Ownership))
    {
        return true;
    }
    let Some(policy) = item.required_policy.as_deref() else {
        return true;
    };
    let Some(feature_key) = guard_policy(policy) else {
        return false;
    };
    let Ok(feature) = Feature::from_str(&feature_key) else {
        return false;
    };
    let resource_type = item.object_type.as_deref().unwrap_or("workflow_run");
    let resource_id = item
        .object_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| item.run_id.to_string());
    let Ok(request) = build_guard_request(
        principal,
        &feature_key,
        org,
        branch,
        resource_type,
        &resource_id,
        WAITING_COMPLETION_DOMAIN,
    ) else {
        return false;
    };
    let entry = workflow_coexistence_entry(
        "workflow.waiting_task.list",
        WAITING_COMPLETION_DOMAIN,
        feature,
        resource_type.to_owned(),
    );
    guard(&request, &entry).is_allowed()
}

fn parse_task_statuses(raw: Option<&str>) -> Result<Vec<WaitingTaskStatus>, WorkflowStudioError> {
    let Some(raw) = raw else {
        return Ok(vec![WaitingTaskStatus::Open]);
    };
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| WaitingTaskStatus::from_db_str(value).map_err(WorkflowStudioError::from))
        .collect()
}

fn parse_run_statuses(raw: Option<&str>) -> Result<Vec<RunStatus>, WorkflowStudioError> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| RunStatus::from_db_str(value).map_err(WorkflowStudioError::from))
        .collect()
}

/// Load a definition's chosen version JSON, gating on ACTIVE status. Returns the
/// resolved `(version, definition)` for the run to bind to.
async fn resolve_start_definition(
    pool: &PgPool,
    org: mnt_kernel_core::OrgId,
    definition_id: Uuid,
    requested_version: Option<i32>,
) -> Result<(i32, Value), WorkflowStudioError> {
    let row = with_org_conn::<_, Option<(String, Option<Value>, Option<i32>)>, DbError>(
        pool,
        org,
        move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT d.status, v.definition, v.version \
                     FROM workflow_definitions d \
                     LEFT JOIN workflow_definition_versions v \
                       ON v.definition_id = d.id AND v.org_id = d.org_id \
                      AND v.version = COALESCE($2, d.active_version) \
                     WHERE d.id = $1",
                )
                .bind(definition_id)
                .bind(requested_version)
                .fetch_optional(tx.as_mut())
                .await?;
                let Some(row) = row else {
                    return Ok(None);
                };
                Ok(Some((
                    row.try_get("status")?,
                    row.try_get("definition")?,
                    row.try_get("version")?,
                )))
            })
        },
    )
    .await
    .map_err(WorkflowStudioError::from)?;

    let Some((status, definition, version)) = row else {
        return Err(WorkflowStudioError::from(KernelError::not_found(
            "workflow definition not found",
        )));
    };
    if status != "ACTIVE" {
        return Err(WorkflowStudioError::from(KernelError::conflict(
            "workflow definition is not active",
        )));
    }
    let (Some(definition), Some(version)) = (definition, version) else {
        return Err(WorkflowStudioError::from(KernelError::conflict(
            "workflow definition has no published version to start",
        )));
    };
    Ok((version, definition))
}

/// Load a run summary + its current OPEN/CLAIMED waiting task (the run's `next_task`).
async fn load_run_view(
    pool: &PgPool,
    org: mnt_kernel_core::OrgId,
    run_id: Uuid,
) -> Result<(RunSummaryResponse, Option<TaskSummaryResponse>), WorkflowStudioError> {
    with_org_conn::<_, (RunSummaryResponse, Option<TaskSummaryResponse>), DbError>(
        pool,
        org,
        move |tx| {
            Box::pin(async move {
                let run = sqlx::query(
                    "SELECT id, status, definition_id, definition_version, object_type, \
                            object_id, initiated_by, started_at \
                     FROM workflow_runs WHERE id = $1",
                )
                .bind(run_id)
                .fetch_one(tx.as_mut())
                .await?;
                let summary = RunSummaryResponse {
                    id: run.try_get("id")?,
                    status: run.try_get("status")?,
                    definition_id: run.try_get("definition_id")?,
                    definition_version: run.try_get("definition_version")?,
                    object_type: run.try_get("object_type")?,
                    object_id: run.try_get("object_id")?,
                    initiated_by: run.try_get("initiated_by")?,
                    started_at: run.try_get("started_at")?,
                };

                let task = sqlx::query(
                    "SELECT t.id AS task_id, t.run_id, t.waiting_key, t.title, \
                            t.assignee_role_key, t.required_policy, t.status, t.claimed_by, \
                            t.due_at, t.form_payload, r.object_type, r.object_id \
                     FROM workflow_waiting_tasks t \
                     JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                     WHERE t.run_id = $1 AND t.status IN ('OPEN', 'CLAIMED') \
                     ORDER BY t.created_at DESC LIMIT 1",
                )
                .bind(run_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let next_task = match task {
                    None => None,
                    Some(task) => Some(TaskSummaryResponse {
                        task_id: task.try_get("task_id")?,
                        run_id: task.try_get("run_id")?,
                        waiting_key: task.try_get("waiting_key")?,
                        title: task.try_get("title")?,
                        assignee_role_key: task.try_get("assignee_role_key")?,
                        required_policy: task.try_get("required_policy")?,
                        object_type: task.try_get("object_type")?,
                        object_id: task.try_get("object_id")?,
                        status: task.try_get("status")?,
                        claimed_by: task.try_get("claimed_by")?,
                        due_at: task.try_get("due_at")?,
                        form_payload: task.try_get("form_payload")?,
                    }),
                };
                Ok((summary, next_task))
            })
        },
    )
    .await
    .map_err(WorkflowStudioError::from)
}

async fn start_workflow_run(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<StartWorkflowRunRequest>,
) -> Result<Json<StartWorkflowRunResponse>, WorkflowStudioError> {
    let idempotency_key = request.idempotency_key.trim();
    if idempotency_key.len() < 16 {
        return Err(WorkflowStudioError::validation(
            "idempotency_key must be at least 16 characters",
        ));
    }
    if request.object_type.is_some() != request.object_id.is_some() {
        return Err(WorkflowStudioError::validation(
            "object_type and object_id must be provided together",
        ));
    }
    // Bound the caller-supplied payloads (security M2): an unbounded input/context
    // blob is a memory/storage abuse vector. 64 KiB serialized is far above any
    // legitimate approval payload; over that is a 422.
    check_payload_size("input_payload", &request.input_payload)?;
    check_payload_size("context_payload", &request.context_payload)?;

    let org = principal.org_id;
    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let (version, definition) = resolve_start_definition(
        &state.pool,
        org,
        request.definition_id,
        request.definition_version,
    )
    .await?;
    let graph = ExecGraph::parse(&definition).map_err(WorkflowStudioError::from)?;
    let entry = graph
        .entry_node_key()
        .map_err(WorkflowStudioError::from)?
        .to_owned();

    // Start authz: legacy-enforce + Cedar-shadow, gated on the definition's
    // per-start authority (security M2). A top-level `start_policy` (additive,
    // wf.exec.v1-compatible) constrains WHO may initiate this definition; when
    // absent it falls back to the entry node's policy. Approval templates
    // deliberately carry NEITHER (their entry gate is self-service) so 전자결재
    // 기안/상신 stays all-employee per DESIGN §4.8; operational pipelines (e.g. the
    // completion→approval→payroll template) set `start_policy` so a start is a
    // policy-gated 403 + shadow for non-privileged personas.
    let branch = guard_branch(&principal);
    let entry_policy = match graph.node_spec(&entry).map(|spec| &spec.kind) {
        Some(NodeKind::HumanTask {
            required_policy, ..
        }) => required_policy.clone(),
        _ => None,
    };
    let start_policy = definition
        .get("start_policy")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or(entry_policy);
    let resource_type = request
        .object_type
        .clone()
        .unwrap_or_else(|| "workflow_run".to_owned());
    let resource_id = request
        .object_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| request.definition_id.to_string());
    let start_shadow = guard_task_policy(
        &principal,
        org,
        branch,
        start_policy.as_deref(),
        &resource_type,
        &resource_id,
        "workflow.run.start",
        request.definition_id,
    )?;

    let run_id = Uuid::new_v4();
    let correlation_id = request
        .correlation_id
        .clone()
        .unwrap_or_else(|| format!("workflow-run:{run_id}"));
    if correlation_id.trim().len() < 8 {
        return Err(WorkflowStudioError::validation(
            "correlation_id must be at least 8 characters",
        ));
    }
    let audit = AuditContext {
        actor: Some(principal.user_id),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    };

    let started = start_run(
        &store,
        StartRunRequest {
            run_id,
            org_id: org,
            definition_id: request.definition_id,
            definition_version: version,
            trigger_type: request.trigger_type,
            object_type: request.object_type.clone(),
            object_id: request.object_id,
            idempotency_key: idempotency_key.to_owned(),
            correlation_id,
            trace_id: None,
            input_payload: request.input_payload.clone(),
            context_payload: request.context_payload.clone(),
            initiated_by: Some(principal.user_id),
        },
        &audit,
    )
    .await;

    let resolved_run_id = match started {
        Ok(id) => {
            // Fresh run: drive synchronously until the first WAITING task or terminal.
            let guard_audits: Vec<AuditEvent> = start_shadow.into_iter().collect();
            drive_from(
                &store,
                org,
                id,
                RunStatus::Running,
                &graph,
                &entry,
                guard_audits,
                &audit,
            )
            .await?;
            id
        }
        Err(err) if err.kind == ErrorKind::Conflict => {
            // Replay: same idempotency_key. Return the existing run if it matches;
            // a mismatch on the same key is a 409.
            match store
                .load_run_by_idempotency_key(org, idempotency_key.to_owned())
                .await?
            {
                Some(existing) => {
                    if existing.definition_id != request.definition_id
                        || existing.object_type != request.object_type
                        || existing.object_id != request.object_id
                    {
                        return Err(WorkflowStudioError::from(KernelError::conflict(
                            "idempotency_key already used for a different run",
                        )));
                    }
                    existing.id
                }
                None => return Err(WorkflowStudioError::from(err)),
            }
        }
        Err(err) => return Err(WorkflowStudioError::from(err)),
    };

    let (run, next_task) = load_run_view(&state.pool, org, resolved_run_id).await?;
    record_workflow_studio_request("run_start", "success");
    Ok(Json(StartWorkflowRunResponse { run, next_task }))
}

async fn list_workflow_tasks(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Query(query): axum::extract::Query<TaskListQuery>,
) -> Result<Json<WorkflowTaskListResponse>, WorkflowStudioError> {
    let assignee_me = query.assignee.as_deref() == Some("me");
    if query.role_key.is_none() && !assignee_me {
        return Err(WorkflowStudioError::validation(
            "workflow-tasks requires role_key or assignee=me",
        ));
    }
    let statuses = parse_task_statuses(query.status.as_deref())?;
    let org = principal.org_id;
    let branch = guard_branch(&principal);

    // Group inbox (security M3): a `role_key=` query returns rows only when the
    // caller holds that role. Deny-by-omission — a caller who does not is handed
    // an empty list (200), never a 403 (never leaks the queue's existence).
    if let Some(role_key) = query.role_key.as_deref()
        && !holds_group_inbox_role(&principal, org, branch, role_key)
    {
        record_workflow_studio_request("task_list", "success");
        return Ok(Json(WorkflowTaskListResponse { items: vec![] }));
    }

    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let items = store
        .list_waiting_tasks(
            org,
            principal.user_id,
            WaitingTaskListFilter {
                role_key: query.role_key.clone(),
                assignee_me,
                // Personal inbox OPEN-task gate (security M3): the authority role
                // keys this caller holds. Ownership-keyed OPEN tasks bind to the
                // run initiator in SQL instead.
                authority_role_keys: held_authority_role_keys(&principal, org, branch),
                statuses,
            },
        )
        .await?;
    let items = items
        .into_iter()
        .filter(|item| task_visible(&principal, org, branch, item))
        .map(TaskSummaryResponse::from)
        .collect();
    record_workflow_studio_request("task_list", "success");
    Ok(Json(WorkflowTaskListResponse { items }))
}

async fn list_my_workflow_runs(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Query(query): axum::extract::Query<RunListQuery>,
) -> Result<Json<RunListResponse>, WorkflowStudioError> {
    let statuses = parse_run_statuses(query.status.as_deref())?;
    let org = principal.org_id;
    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let items = store
        .list_runs_for_initiator(
            org,
            principal.user_id,
            RunListFilter {
                statuses,
                object_type: query.object_type.clone(),
                // Empty/whitespace-only q is treated as absent (returns all rows).
                q: query
                    .q
                    .as_deref()
                    .map(str::trim)
                    .filter(|q| !q.is_empty())
                    .map(ToOwned::to_owned),
            },
        )
        .await?;
    record_workflow_studio_request("run_mine", "success");
    Ok(Json(RunListResponse {
        items: items.into_iter().map(RunListItemResponse::from).collect(),
    }))
}

async fn claim_workflow_task(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(task_id): Path<Uuid>,
    Json(request): Json<ClaimWorkflowTaskRequest>,
) -> Result<Json<ClaimTaskResponse>, WorkflowStudioError> {
    if request.idempotency_key.trim().len() < 16 {
        return Err(WorkflowStudioError::validation(
            "idempotency_key must be at least 16 characters",
        ));
    }
    let org = principal.org_id;
    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let context = store
        .load_finalize_waiting_task(org, task_id)
        .await?
        .ok_or_else(|| KernelError::not_found("workflow task not found"))?;

    // Defense in depth (security H1): a legacy task row that predates the
    // authoring-time `required_policy` requirement carries no authorization
    // boundary. Refuse the mutation rather than let any org member claim it.
    require_task_authorization_boundary(context.required_policy.as_deref())?;

    let branch = guard_branch(&principal);
    let resource_type = context.object_type.as_deref().unwrap_or("workflow_run");
    let resource_id = context
        .object_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| context.run_id.to_string());
    let shadow = guard_task_policy(
        &principal,
        org,
        branch,
        context.required_policy.as_deref(),
        resource_type,
        &resource_id,
        "workflow.waiting_task.claim",
        task_id,
    )?;

    let claimed = store
        .claim_waiting_task(
            org,
            ClaimWaitingTaskCommand {
                task_id,
                actor: principal.user_id,
                transition_audits: shadow.into_iter().collect(),
            },
        )
        .await?;
    record_workflow_studio_request("task_claim", "success");
    Ok(Json(ClaimTaskResponse {
        task: ClaimedTaskResponse {
            task_id: claimed.task_id,
            run_id: claimed.run_id,
            status: claimed.status.as_db_str().to_owned(),
            claimed_by: claimed.claimed_by,
            claimed_at: claimed.claimed_at,
        },
    }))
}

async fn decide_workflow_task(
    State(state): State<WorkflowStudioState>,
    Extension(principal): Extension<Principal>,
    Path(task_id): Path<Uuid>,
    Json(request): Json<DecideWorkflowTaskRequest>,
) -> Result<Json<DecideTaskResponse>, WorkflowStudioError> {
    let idempotency_key = request.idempotency_key.trim();
    if idempotency_key.len() < 16 {
        return Err(WorkflowStudioError::validation(
            "idempotency_key must be at least 16 characters",
        ));
    }
    // Bound the free-text comment (security L5), mirroring the DB-bounded reason
    // pattern of migration 0096: an over-long comment is a 422, not a silent DB
    // truncation or an unbounded write.
    if request
        .comment
        .as_deref()
        .is_some_and(|comment| comment.chars().count() > 4000)
    {
        return Err(WorkflowStudioError::validation(
            "comment must be at most 4000 characters",
        ));
    }
    let decision = TaskDecision::from(request.decision);
    let comment = request
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if matches!(decision, TaskDecision::Reject | TaskDecision::Return) && comment.is_none() {
        return Err(WorkflowStudioError::validation(
            "reject and return require a non-empty comment",
        ));
    }

    let org = principal.org_id;
    let store = PgWorkflowRuntimeStore::new(state.pool.clone());
    let context = store
        .load_finalize_waiting_task(org, task_id)
        .await?
        .ok_or_else(|| KernelError::not_found("workflow task not found"))?;

    // Defense in depth (security H1): a policy-less legacy task row has no
    // authorization boundary — refuse to decide it (403) rather than let any
    // org member push the run forward.
    require_task_authorization_boundary(context.required_policy.as_deref())?;

    let branch = guard_branch(&principal);
    let resource_type = context.object_type.as_deref().unwrap_or("workflow_run");
    let resource_id = context
        .object_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| context.run_id.to_string());
    let shadow = guard_task_policy(
        &principal,
        org,
        branch,
        context.required_policy.as_deref(),
        resource_type,
        &resource_id,
        "workflow.waiting_task.decide",
        task_id,
    )?;

    let decided = store
        .decide_waiting_task(
            org,
            DecideWaitingTaskCommand {
                task_id,
                actor: principal.user_id,
                decision,
                comment: comment.map(ToOwned::to_owned),
                idempotency_key: idempotency_key.to_owned(),
                transition_audits: shadow.into_iter().collect(),
            },
        )
        .await?;
    record_workflow_studio_request("task_decide", "success");
    Ok(Json(DecideTaskResponse {
        task: DecidedTaskResponse {
            task_id: decided.task_id,
            run_id: decided.run_id,
            status: decided.status.as_db_str().to_owned(),
            decision_payload: decided.decision_payload,
        },
        run: FinalizedRunResponse {
            id: decided.run_id,
            status: decided.run_status.as_db_str().to_owned(),
        },
        next_task: decided.next_task.map(TaskSummaryResponse::from),
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
            let updated = insert_version_and_update_definition(
                tx,
                WorkflowVersionMutation {
                    org,
                    actor,
                    source: &next,
                    new_version,
                    version_status: "DRAFT",
                    definition_status: "DRAFT",
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
            ensure_not_retired(&source)?;
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
            latest_version, active_version, created_at, updated_at
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
        .map(validate_definition_object)
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
    ensure_draft_definition(current, "edited")?;
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

#[allow(dead_code)]
fn build_approval_execution_definition(template_key: &str) -> Result<Value, WorkflowStudioError> {
    let template = APPROVAL_TEMPLATES
        .iter()
        .find(|template| template.key == template_key)
        .ok_or_else(|| WorkflowStudioError::validation("unknown approval template"))?;

    let mut nodes = Vec::with_capacity(template.default_line.len() + 3);
    nodes.push(json!({ "node_key": "submit", "node_type": "object_gate" }));
    for (index, role_key) in template.default_line.iter().enumerate() {
        nodes.push(json!({
            "node_key": format!("approve.{role_key}"),
            "node_type": "human_task",
            "title": format!("Approval step {}", index + 1),
            "required_policy": "approval_decide",
            "assignee_role_key": role_key
        }));
    }
    nodes.push(json!({
        "node_key": "finalize.author",
        "node_type": "human_task",
        "title": "Author finalize",
        "required_policy": "approval_finalize",
        "assignee_role_key": "initiator"
    }));
    if template.receipt_required {
        nodes.push(json!({
            "node_key": "receipt.target",
            "node_type": "human_task",
            "title": "Receipt confirmation",
            "required_policy": "approval_receipt",
            "assignee_role_key": "receipt_subject"
        }));
    }

    let mut edges = Vec::with_capacity(nodes.len().saturating_sub(1));
    for pair in nodes.windows(2) {
        edges.push(json!({
            "from": pair[0]["node_key"],
            "to": pair[1]["node_key"]
        }));
    }

    // No `start_policy`: 전자결재 기안/상신 is deliberately all-employee self-service
    // (DESIGN §4.8) — any employee may draft/submit an approval document. Only
    // operational pipelines (e.g. the completion→approval→payroll template) carry
    // a `start_policy` to constrain who may initiate them (security M2).
    Ok(json!({
        "schema_version": WORKFLOW_EXEC_SCHEMA_VERSION,
        "workflow_key": template.workflow_key,
        "object_type": "approval_document",
        "approval_template": template.key,
        "reason_enum": template.reason_enum,
        "linked_objects": template.linked_objects.iter().map(|link| {
            json!({ "kind": link.kind, "required": link.required })
        }).collect::<Vec<_>>(),
        "nodes": nodes,
        "edges": edges
    }))
}

fn validate_definition_object(value: Value) -> Result<Value, WorkflowStudioError> {
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
    Ok(value)
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
    let mut has_job = false;
    for node in nodes {
        let node = node.as_object().ok_or_else(|| {
            WorkflowStudioError::validation("execution nodes must be JSON objects")
        })?;
        required_string(node, "node_key")?;
        match required_string(node, "node_type")? {
            "object_gate" | "object_mutation" => {}
            "human_task" => {
                required_string(node, "assignee_role_key")?;
                // Fail-closed authorization boundary (security H1): a human task
                // MUST declare the policy that gates who may claim/decide it. An
                // omitted `required_policy` is an authoring-time 422, never a task
                // any org member could act on.
                required_string(node, "required_policy")?;
            }
            "job" => {
                has_job = true;
                let connector_key = required_string(node, "connector_key")?;
                let action_key = required_string(node, "action_key")?;
                if !connector_allows(connector_key, action_key) {
                    return Err(WorkflowStudioError::validation(format!(
                        "execution node job action {connector_key}.{action_key} is not in the Workflow Studio connector allowlist"
                    )));
                }
            }
            other => {
                return Err(WorkflowStudioError::validation(format!(
                    "unsupported execution node_type {other}"
                )));
            }
        }
    }
    // Fail-closed start authority (Engine-Gen follow-up): a graph containing a `job`
    // node drives a system connector (e.g. the completion→approval→payroll pipeline's
    // payroll_draft), so it MUST declare a top-level `start_policy` constraining WHO
    // may initiate a run. Runtime start-authz already gates job pipelines on this
    // policy; authoring now refuses a job-bearing graph without it (422) so no
    // author-composed definition can slip a job into a self-service, all-employee
    // start. Job-free approval graphs stay deliberately self-service and unaffected.
    if has_job
        && object
            .get("start_policy")
            .and_then(Value::as_str)
            .filter(|policy| !policy.trim().is_empty())
            .is_none()
    {
        return Err(WorkflowStudioError::validation(
            "execution definition with a job node requires a non-empty start_policy",
        ));
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
    if row.definition.get("policy_decision").is_some()
        && let Err(error) = validate_definition_object(row.definition.clone())
    {
        findings.push(WorkflowSimulationFinding {
            severity: "blocker".to_owned(),
            code: "invalid_policy_decision".to_owned(),
            message: error.message,
        });
    }
    findings
}

fn validate_publishable(row: &WorkflowVersionRow) -> Vec<WorkflowSimulationFinding> {
    validation_findings(row)
        .into_iter()
        .filter(|finding| finding.severity == "blocker")
        .collect()
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

fn guard_branch(principal: &Principal) -> BranchId {
    match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches
            .iter()
            .next()
            .copied()
            .unwrap_or_else(BranchId::new),
    }
}

fn shadow_audit_event(
    shadow: &AuthorizationAuditEvent,
    actor: UserId,
    org: mnt_kernel_core::OrgId,
    task_id: Uuid,
) -> Result<AuditEvent, KernelError> {
    shadow_audit_event_for(shadow, actor, org, "workflow_waiting_task", task_id)
}

fn shadow_audit_event_for(
    shadow: &AuthorizationAuditEvent,
    actor: UserId,
    org: mnt_kernel_core::OrgId,
    target_type: &'static str,
    target_id: Uuid,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_runtime.cedar_shadow")?,
        target_type,
        target_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::to_value(shadow).map_err(|err| KernelError::internal(err.to_string()))?),
    ))
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

    /// The canonical completion→approval→payroll executable node graph (design
    /// §template). Published via Studio as a `wf.exec.v1` definition; the M2 runtime
    /// walks it. `emit_payroll` fans out through the `internal.jobs` JOB connector.
    fn maintenance_completion_execution_definition() -> Value {
        json!({
            "schema_version": WORKFLOW_EXEC_SCHEMA_VERSION,
            "workflow_key": "work_order.maintenance_completion",
            "object_type": "work_order",
            // Operational pipeline, NOT self-service 기안: only completion_review
            // authority may initiate the completion→approval→payroll run (security
            // M2). Contrast the approval templates, which carry no `start_policy`.
            "start_policy": "completion_review",
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
    fn receipt_required_approval_definition_includes_receipt_waiting_node() -> Result<(), String> {
        let definition = build_approval_execution_definition("leave")
            .map_err(|err| format!("leave template should build: {}", err.message))?;

        validate_definition_object(definition.clone())
            .map_err(|err| format!("leave approval graph must validate: {}", err.message))?;

        let nodes = definition["nodes"]
            .as_array()
            .ok_or_else(|| "nodes must be an array".to_owned())?;
        assert!(
            nodes.iter().any(|node| {
                node["node_key"] == json!("receipt.target")
                    && node["node_type"] == json!("human_task")
                    && node["assignee_role_key"] == json!("receipt_subject")
                    && node["required_policy"] == json!("approval_receipt")
            }),
            "receipt-required template must emit receipt.target human task"
        );

        let edges = definition["edges"]
            .as_array()
            .ok_or_else(|| "edges must be an array".to_owned())?;
        assert!(
            edges
                .iter()
                .any(|edge| edge["from"] == json!("finalize.author")
                    && edge["to"] == json!("receipt.target")),
            "receipt-required template must route finalization to receipt confirmation"
        );
        Ok(())
    }

    #[test]
    fn all_approval_template_builder_outputs_validate() -> Result<(), String> {
        for template in APPROVAL_TEMPLATES {
            let definition = build_approval_execution_definition(template.key)
                .map_err(|err| format!("{} should build: {}", template.key, err.message))?;
            validate_definition_object(definition.clone()).map_err(|err| {
                format!(
                    "{} approval graph must validate: {}",
                    template.key, err.message
                )
            })?;

            let has_receipt = definition["nodes"]
                .as_array()
                .ok_or_else(|| format!("{} nodes must be an array", template.key))?
                .iter()
                .any(|node| node["node_key"] == json!("receipt.target"));
            assert_eq!(
                has_receipt, template.receipt_required,
                "{} receipt node must match catalog flag",
                template.key
            );
        }
        Ok(())
    }

    #[test]
    fn human_task_without_required_policy_fails_authoring() -> Result<(), String> {
        // Security H1(a): a human_task node MUST declare required_policy at authoring
        // time. Drop it from the executable graph → publish-validation is a 422.
        let mut definition = maintenance_completion_execution_definition();
        // node 1 is the admin_approval human_task.
        definition["nodes"][1]
            .as_object_mut()
            .ok_or_else(|| "node must be an object".to_owned())?
            .remove("required_policy");
        let err = match validate_definition_object(definition) {
            Ok(_) => {
                return Err("a human_task without required_policy must fail closed".to_owned());
            }
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            err.message.contains("required_policy"),
            "message should name the missing field: {}",
            err.message
        );
        Ok(())
    }

    #[test]
    fn job_node_without_start_policy_fails_authoring() -> Result<(), String> {
        // Engine-Gen follow-up: a graph containing a `job` node MUST declare a
        // top-level start_policy at authoring time (fail-closed start authority).
        // Drop start_policy from the canonical completion→approval→payroll graph
        // (which carries a payroll job) → publish-validation is a 422.
        let mut definition = maintenance_completion_execution_definition();
        definition
            .as_object_mut()
            .ok_or_else(|| "definition must be an object".to_owned())?
            .remove("start_policy");
        let err = match validate_definition_object(definition) {
            Ok(_) => {
                return Err("a job-bearing graph without start_policy must fail closed".to_owned());
            }
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            err.message.contains("start_policy"),
            "message should name the missing field: {}",
            err.message
        );

        // With start_policy present the same job-bearing graph validates.
        validate_definition_object(maintenance_completion_execution_definition()).map_err(
            |err| {
                format!(
                    "job-bearing graph with start_policy must validate: {}",
                    err.message
                )
            },
        )?;

        // A job-free approval graph is unaffected — no start_policy required.
        let approval = build_approval_execution_definition("leave")
            .map_err(|err| format!("leave template should build: {}", err.message))?;
        assert!(
            approval.get("start_policy").is_none(),
            "approval templates deliberately carry no start_policy"
        );
        validate_definition_object(approval).map_err(|err| {
            format!(
                "job-free approval graph must validate without start_policy: {}",
                err.message
            )
        })?;
        Ok(())
    }

    #[test]
    fn oversize_run_payload_is_rejected() -> Result<(), String> {
        // Security M2: a payload over the 64 KiB serialized ceiling is a 422.
        let big = json!({ "blob": "x".repeat(MAX_RUN_PAYLOAD_BYTES + 1) });
        let err = match check_payload_size("input_payload", &big) {
            Ok(()) => return Err("oversize payload must be rejected".to_owned()),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        // A modest payload passes.
        check_payload_size("input_payload", &json!({ "reason": "annual" }))
            .map_err(|e| format!("a small payload must pass: {}", e.message))?;
        Ok(())
    }

    #[test]
    fn policy_less_task_has_no_authorization_boundary() -> Result<(), String> {
        // Security H1(b): the claim/decide path fails closed (403) on a legacy
        // policy-less row; a policy-bearing row passes the boundary check.
        let err = match require_task_authorization_boundary(None) {
            Ok(()) => return Err("a policy-less task must be refused".to_owned()),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert!(err.message.contains("authorization boundary"));
        require_task_authorization_boundary(Some("approval_finalize"))
            .map_err(|e| format!("a policy-bearing task must pass: {}", e.message))?;
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

    fn policy_decision_definition() -> Value {
        json!({
            "schema_version": "workflow.definition.v1",
            "policy_decision": {
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
            }
        })
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
            finding.code == "invalid_policy_decision" && finding.message.contains("schema_version")
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
        let mut row = policy_row(json!({}));
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
