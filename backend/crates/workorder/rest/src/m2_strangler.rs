//! M2 workflow-runtime strangler seam (design §Strangler, step 7).
//!
//! Routes the work-order completion path (executive approval → `FINAL_COMPLETED`)
//! through the M2 workflow runtime for tenants whose per-tenant
//! `workflow_runtime_m2_strangler` flag is ON. The flag ships DARK (absent row ⇒
//! `org_runtime_flag_enabled()` ⇒ FALSE ⇒ every tenant OFF), so in production this
//! seam is inert and the legacy path runs byte-for-byte.
//!
//! ## Ordering (legacy-first, additive)
//! The legacy `approve_work_order` adapter call ALWAYS runs first and unchanged —
//! it performs the `work_orders` `FINAL_COMPLETED` mutation + audit in its own
//! transaction. Only *after* the completion has persisted, and only when the flag
//! resolves ON, does this seam additively drive the runtime to RECORD the
//! completion run and enqueue the payroll JOB outbox event. A runtime failure never
//! rolls back (or blocks) a completion that already committed; the worst case is a
//! missing async payroll draft, which the outbox drainer restages. The OFF path
//! executes exactly one read-only flag SELECT and returns — no `workflow_runs`,
//! node runs, waiting tasks, outbox events, or `payroll_draft_runs` rows are
//! written, so it is byte-identical to legacy.
//!
//! ## Scope (design mismatch, deliberately reported)
//! As-built, the runtime interpreter's `object_mutation` node does NOT itself write
//! `work_orders` (the caller's transaction does — `interpreter.rs:24-27`) and no
//! cross-context shared-transaction API exists, so the design's "runtime owns the
//! FinalCompleted mutation in its own txn" is not buildable within the slice's
//! constraints. This seam follows the as-built contract: legacy owns the mutation;
//! the runtime records the terminal tail `apply_completion` → `emit_payroll`. The
//! admin/executive human-task gates were already enforced by the legacy approval
//! line, so they are treated as satisfied preconditions rather than re-modelled as
//! runtime waiting tasks (which would require start/park wiring at earlier lifecycle
//! steps — a separate charter).

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, KernelError, OrgId, TraceContext, UserId, WorkOrderId,
};
use mnt_platform_authz::{AuthorizationAuditEvent, Feature, Principal};
use mnt_platform_db::with_org_conn;
use mnt_platform_request_context::current_org;
use mnt_workflow_domain::{RunStatus, TriggerType};
use mnt_workflow_runtime::idempotency::run_completion_key;
use mnt_workflow_runtime::{
    AuditContext, NODE_TRANSITION_DOMAIN, NodeKind, NodeSpec, ProcessNodeRequest, StartRunRequest,
    build_guard_request, guard, process_node, start_run, workflow_coexistence_entry,
};
use mnt_workflow_runtime_adapter_postgres::{M2_STRANGLER_FLAG, PgWorkflowRuntimeStore};
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::RestError;

/// Drive the M2 completion runtime for a work order that just reached
/// `FINAL_COMPLETED` through the (unchanged) legacy path — but ONLY if the tenant's
/// strangler flag is ON. A no-op (single read-only flag SELECT) for every OFF
/// tenant, so the completion path stays byte-identical to legacy when dark.
pub(crate) async fn drive_completion_if_enabled(
    runtime: &PgWorkflowRuntimeStore,
    principal: &Principal,
    branch_id: BranchId,
    work_order_id: WorkOrderId,
) -> Result<(), RestError> {
    let org = current_org().map_err(|err| RestError::from_kernel(err.into()))?;

    // Dark default: absent row ⇒ FALSE ⇒ legacy path, zero runtime state written.
    if !runtime
        .strangler_flag_enabled(org, M2_STRANGLER_FLAG)
        .await
        .map_err(RestError::from_kernel)?
    {
        return Ok(());
    }

    // Resolve the tenant's active executable (`wf.exec.v1`) work-order completion
    // definition. Without one published there is nothing to drive (the completion
    // already persisted via legacy) — a real, benign skip, not a stub.
    let Some((definition_id, definition_version)) =
        resolve_completion_definition(runtime.pool(), org).await?
    else {
        tracing::info!(
            org = %org,
            work_order_id = %work_order_id,
            "m2 strangler: flag ON but no active wf.exec.v1 work_order definition; skipping runtime record"
        );
        return Ok(());
    };

    record_completion_run(
        runtime,
        principal,
        org,
        branch_id,
        work_order_id,
        definition_id,
        definition_version,
    )
    .await
    .map_err(RestError::from_kernel)
}

/// Find the tenant's active executable work-order completion definition
/// (`workflow_definitions.status = ACTIVE` with a `wf.exec.v1` active version).
/// Read as the runtime role under the armed `app.current_org` (via `with_org_conn`),
/// so RLS scopes it to this tenant. `None` when no such definition is published.
async fn resolve_completion_definition(
    pool: &sqlx::PgPool,
    org: OrgId,
) -> Result<Option<(Uuid, i32)>, RestError> {
    with_org_conn::<_, Option<(Uuid, i32)>, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT d.id, d.active_version \
                 FROM workflow_definitions d \
                 JOIN workflow_definition_versions v \
                   ON v.definition_id = d.id AND v.version = d.active_version \
                 WHERE d.object_type = 'work_order' \
                   AND d.status = 'ACTIVE' \
                   AND d.active_version IS NOT NULL \
                   AND v.definition->>'schema_version' = 'wf.exec.v1' \
                 ORDER BY d.updated_at DESC \
                 LIMIT 1",
            )
            .fetch_optional(tx.as_mut())
            .await?;
            match row {
                Some(row) => {
                    let id: Uuid = row.try_get("id")?;
                    let version: i32 = row.try_get("active_version")?;
                    Ok(Some((id, version)))
                }
                None => Ok(None),
            }
        })
    })
    .await
}

/// Drive the terminal completion tail through the runtime engine + Postgres adapter:
/// `start_run` (STARTING→RUNNING) → `apply_completion` (object_mutation, run stays
/// RUNNING) → `emit_payroll` (job, run→SUCCEEDED). Every write is armed + audited by
/// the adapter's own `with_audits`/`with_audit` transactions.
async fn record_completion_run(
    runtime: &PgWorkflowRuntimeStore,
    principal: &Principal,
    org: OrgId,
    branch_id: BranchId,
    work_order_id: WorkOrderId,
    definition_id: Uuid,
    definition_version: i32,
) -> Result<(), KernelError> {
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();
    let audit = AuditContext {
        actor: Some(actor),
        trace: TraceContext::generate(),
        occurred_at: now,
    };

    let run_id = Uuid::new_v4();
    let work_order_uuid = *work_order_id.as_uuid();

    // 1. Start the run: STARTING → RUNNING. Idempotent on the per-work-order run
    //    key, so a duplicate completion cannot open a second run (409 → conflict).
    start_run(
        runtime,
        StartRunRequest {
            run_id,
            org_id: org,
            definition_id,
            definition_version,
            trigger_type: TriggerType::ObjectEvent,
            object_type: Some("work_order".to_owned()),
            object_id: Some(work_order_uuid),
            idempotency_key: run_completion_key(work_order_id),
            correlation_id: format!("work_order_completion:{work_order_id}"),
            trace_id: None,
            input_payload: json!({ "work_order_id": work_order_uuid }),
            context_payload: json!({}),
            initiated_by: Some(actor),
        },
        &audit,
    )
    .await?;

    // 2. apply_completion (object_mutation). The `work_orders` FINAL_COMPLETED write
    //    was already performed by the legacy path; this node records the terminal
    //    business transition. Per design §D it is the sole per-request Cedar-guarded
    //    transition on this tail: under `LegacyOnly` the legacy contract is the sole
    //    enforcer (fail-closed if it denies), the inert Cedar verdict never blocks,
    //    and the shadow decision rides the node's own `with_audits` txn via
    //    `guard_audits`.
    let guard_request = build_guard_request(
        principal,
        "completion_review",
        org,
        branch_id,
        "work_order",
        &work_order_id.to_string(),
        NODE_TRANSITION_DOMAIN,
    )?;
    let entry = workflow_coexistence_entry(
        "workflow.node_transition.completion_review",
        NODE_TRANSITION_DOMAIN,
        Feature::CompletionReview,
        "work_order",
    );
    let guard_outcome = guard(&guard_request, &entry);
    if !guard_outcome.is_allowed() {
        return Err(KernelError::forbidden(
            "workflow runtime completion transition denied by the legacy authorization contract",
        ));
    }
    let shadow_audit = shadow_audit_event(&guard_outcome.audit, actor, org, work_order_id, now)?;

    process_node(
        runtime,
        ProcessNodeRequest {
            org_id: org,
            run_id,
            node_run_id: Uuid::new_v4(),
            current_run_status: RunStatus::Running,
            run_target: RunStatus::Running,
            spec: NodeSpec {
                node_key: "apply_completion".to_owned(),
                node_type: "object_mutation".to_owned(),
                kind: NodeKind::ObjectMutation,
            },
            attempt: 1,
            input_payload: json!({
                "work_order_id": work_order_uuid,
                "target_status": "FINAL_COMPLETED",
            }),
            guard_audits: vec![shadow_audit],
        },
        &audit,
    )
    .await?;

    // 3. emit_payroll (job → run SUCCEEDED). A worker-driven system node: audited but
    //    NOT per-request Cedar-guarded (design §D). Enqueues exactly one JOB outbox
    //    event to internal.jobs; the drainer later stages a BLOCKED_LEGAL_GATE draft.
    let period = now.date();
    process_node(
        runtime,
        ProcessNodeRequest {
            org_id: org,
            run_id,
            node_run_id: Uuid::new_v4(),
            current_run_status: RunStatus::Running,
            run_target: RunStatus::Succeeded,
            spec: NodeSpec {
                node_key: "emit_payroll".to_owned(),
                node_type: "job".to_owned(),
                kind: NodeKind::Job {
                    connector: "internal.jobs".to_owned(),
                    job: "payroll_draft".to_owned(),
                    emits_status: Some("BLOCKED_LEGAL_GATE".to_owned()),
                },
            },
            attempt: 1,
            input_payload: json!({
                "work_order_id": work_order_uuid,
                "period_start": period.to_string(),
                "period_end": period.to_string(),
            }),
            guard_audits: Vec::new(),
        },
        &audit,
    )
    .await?;

    Ok(())
}

/// Bridge a Cedar/PBAC observe-and-record shadow event into a kernel `AuditEvent`
/// so it can land in the guarded node's own `with_audits` transaction. The full
/// server-derived shadow record (enforced decision + inert Cedar verdict) is
/// preserved in the audit `after` snapshot for the forensic trail.
fn shadow_audit_event(
    shadow: &AuthorizationAuditEvent,
    actor: UserId,
    org: OrgId,
    work_order_id: WorkOrderId,
    occurred_at: OffsetDateTime,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_runtime.cedar_shadow")?,
        "work_order",
        work_order_id.to_string(),
        TraceContext::generate(),
        occurred_at,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::to_value(shadow).map_err(|err| KernelError::internal(err.to_string()))?),
    ))
}
