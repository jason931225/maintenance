//! Postgres work-order adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    BranchId, CustomerId, DailyPlanId, EquipmentId, ErrorKind, KernelError, SiteId, UserId,
    VendorId, WorkOrderId,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_workorder_application::{
    CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand, DailyPlanStatus,
    DailyPlanSummary, OutsourceWorkStatus, OutsourceWorkSummary, ReviewDailyPlanCommand,
    ReviewTargetChangeCommand, SendDailyPlanForReviewCommand, SubmitReportCommand,
    TargetChangeDecision, TargetChangeRequestCommand, TargetChangeRequestSummary,
    TargetChangeStatus, UpdatePriorityCommand, WorkOrderApprovalCommand,
    WorkOrderAssignmentCommand, WorkOrderStartCommand, WorkOrderSummary, daily_plan_audit_event,
    work_order_audit_event,
};
use mnt_workorder_domain::{
    ApprovalRole, PriorityLevel, TransitionActor, TransitionGuardContext, WorkOrderAssignment,
    WorkOrderAssignments, WorkOrderStatus, WorkResultType, validate_status_transition,
};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::Date;

#[derive(Debug, thiserror::Error)]
pub enum PgWorkOrderError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgWorkOrderError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(err)))
                if err.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgWorkOrderError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgWorkOrderStore {
    pool: PgPool,
}

impl PgWorkOrderStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_work_order(
        &self,
        command: CreateWorkOrderCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let work_order_id = WorkOrderId::new();
        let normalized_management_no = normalize_management_no(&command.management_no)?;
        let branch_id = command.branch_id;
        let branch_uuid = *branch_id.as_uuid();
        let actor = command.actor;
        let symptom = command.symptom;
        let customer_request = command.customer_request;
        let target_due_at = command.target_due_at;
        let occurred_at = command.occurred_at;
        let request_date = occurred_at.date();
        let event = work_order_audit_event(
            "work_order.create",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if symptom.trim().is_empty() {
                    return Err(KernelError::validation("work-order symptom is required").into());
                }

                let equipment =
                    lookup_equipment_for_management_no(tx, branch_uuid, &normalized_management_no)
                        .await?;
                let request_no = next_request_no(tx, request_date).await?;
                let id_uuid = *work_order_id.as_uuid();

                sqlx::query(
                    r#"
                    INSERT INTO work_orders (
                        id, request_no, branch_id, equipment_id, customer_id, site_id,
                        requested_by, status, priority, symptom, customer_request,
                        target_due_at, created_at, updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6,
                        $7, $8, $9, $10, $11,
                        $12, $13, $13
                    )
                    "#,
                )
                .bind(id_uuid)
                .bind(request_no)
                .bind(branch_uuid)
                .bind(equipment.equipment_id)
                .bind(equipment.customer_id)
                .bind(equipment.site_id)
                .bind(*actor.as_uuid())
                .bind(WorkOrderStatus::Received.as_db_str())
                .bind(PriorityLevel::Unset.as_db_str())
                .bind(symptom.trim())
                .bind(customer_request.as_deref().map(str::trim))
                .bind(target_due_at)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                insert_status_history(
                    tx,
                    work_order_id,
                    Some(actor),
                    "work_order.create",
                    None,
                    WorkOrderStatus::Received,
                    occurred_at,
                )
                .await?;

                fetch_work_order_summary_tx(tx, work_order_id).await
            })
        })
        .await
    }

    pub async fn update_priority(
        &self,
        command: UpdatePriorityCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let priority = command.priority;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.priority",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = lock_work_order(tx, work_order_id).await?;
                sqlx::query(
                    r#"
                    UPDATE work_orders
                    SET priority = $2, updated_at = $3
                    WHERE id = $1
                    "#,
                )
                .bind(row.id)
                .bind(priority.as_db_str())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                fetch_work_order_summary_tx(tx, work_order_id).await
            })
        })
        .await
    }

    pub async fn assign_work_order(
        &self,
        command: WorkOrderAssignmentCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let actor = command.actor;
        let assignments = command.assignments;
        let admin_approver_id = command.admin_approver_id;
        let executive_approver_id = command.executive_approver_id;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.assign",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let domain_assignments = assignments
                    .iter()
                    .map(|assignment| {
                        WorkOrderAssignment::new(assignment.mechanic_id, assignment.role)
                    })
                    .collect();
                let domain_assignments = WorkOrderAssignments::new(domain_assignments)?;
                let primary_mechanic = domain_assignments.primary().mechanic_id();
                let row = lock_work_order(tx, work_order_id).await?;
                validate_status_transition(
                    row.status,
                    WorkOrderStatus::Assigned,
                    TransitionGuardContext::admin(),
                )?;

                sqlx::query("DELETE FROM work_order_assignments WHERE work_order_id = $1")
                    .bind(row.id)
                    .execute(tx.as_mut())
                    .await?;
                sqlx::query("DELETE FROM work_order_approval_steps WHERE work_order_id = $1")
                    .bind(row.id)
                    .execute(tx.as_mut())
                    .await?;

                for assignment in assignments {
                    sqlx::query(
                        r#"
                        INSERT INTO work_order_assignments (
                            work_order_id, mechanic_id, role, assigned_at
                        )
                        VALUES ($1, $2, $3, $4)
                        "#,
                    )
                    .bind(row.id)
                    .bind(*assignment.mechanic_id.as_uuid())
                    .bind(assignment.role.as_db_str())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                insert_approval_step(
                    tx,
                    work_order_id,
                    1,
                    ApprovalRole::Mechanic,
                    Some(primary_mechanic),
                    "PENDING",
                    Some(occurred_at),
                )
                .await?;
                insert_approval_step(
                    tx,
                    work_order_id,
                    2,
                    ApprovalRole::Admin,
                    admin_approver_id,
                    "NOT_STARTED",
                    None,
                )
                .await?;
                insert_approval_step(
                    tx,
                    work_order_id,
                    3,
                    ApprovalRole::Executive,
                    executive_approver_id,
                    "NOT_STARTED",
                    None,
                )
                .await?;

                update_status(
                    tx,
                    row,
                    actor,
                    "work_order.assign",
                    WorkOrderStatus::Assigned,
                    occurred_at,
                )
                .await
            })
        })
        .await
    }

    pub async fn start_work(
        &self,
        command: WorkOrderStartCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.start",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = lock_work_order(tx, work_order_id).await?;
                ensure_actor_assignment(tx, work_order_id, actor, AssignmentRequirement::Optional)
                    .await?;
                validate_status_transition(
                    row.status,
                    WorkOrderStatus::InProgress,
                    TransitionGuardContext::mechanic(),
                )?;

                update_status(
                    tx,
                    row,
                    actor,
                    "work_order.start",
                    WorkOrderStatus::InProgress,
                    occurred_at,
                )
                .await
            })
        })
        .await
    }

    pub async fn submit_report(
        &self,
        command: SubmitReportCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let actor = command.actor;
        let result_type = command.result_type;
        let diagnosis = command.diagnosis;
        let action_taken = command.action_taken;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.report",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if diagnosis.trim().is_empty() || action_taken.trim().is_empty() {
                    return Err(KernelError::validation(
                        "diagnosis and action taken are required for report submission",
                    )
                    .into());
                }
                let row = lock_work_order(tx, work_order_id).await?;
                ensure_actor_assignment(tx, work_order_id, actor, AssignmentRequirement::Required)
                    .await?;
                validate_status_transition(
                    row.status,
                    WorkOrderStatus::ReportSubmitted,
                    TransitionGuardContext::mechanic(),
                )?;

                sqlx::query(
                    r#"
                    UPDATE work_orders
                    SET result_type = $2,
                        diagnosis = $3,
                        action_taken = $4,
                        report_submitted_by = $5,
                        report_submitted_at = $6
                    WHERE id = $1
                    "#,
                )
                .bind(row.id)
                .bind(result_type.as_db_str())
                .bind(diagnosis.trim())
                .bind(action_taken.trim())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    UPDATE work_order_approval_steps
                    SET status = 'APPROVED',
                        approved_at = $2,
                        approved_by_id = COALESCE(approver_id, $3),
                        updated_at = $2
                    WHERE work_order_id = $1
                      AND role = 'MECHANIC'
                      AND status = 'PENDING'
                    "#,
                )
                .bind(row.id)
                .bind(occurred_at)
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    UPDATE work_order_approval_steps
                    SET status = 'PENDING',
                        requested_at = $2,
                        updated_at = $2
                    WHERE work_order_id = $1
                      AND role = 'ADMIN'
                      AND status = 'NOT_STARTED'
                    "#,
                )
                .bind(row.id)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                update_status(
                    tx,
                    row,
                    actor,
                    "work_order.report",
                    WorkOrderStatus::ReportSubmitted,
                    occurred_at,
                )
                .await
            })
        })
        .await
    }

    pub async fn approve_work_order(
        &self,
        command: WorkOrderApprovalCommand,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.approve",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, WorkOrderSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = lock_work_order(tx, work_order_id).await?;
                let pending = pending_non_mechanic_approval_step(tx, work_order_id).await?;
                if let Some(approver_id) = pending.approver_id
                    && approver_id != actor
                {
                    return Err(KernelError::forbidden(
                        "actor is not assigned to the pending approval step",
                    )
                    .into());
                }

                let to = match pending.role {
                    ApprovalRole::Admin => WorkOrderStatus::AdminReview,
                    ApprovalRole::Executive if row.result_type == WorkResultType::Completed => {
                        WorkOrderStatus::FinalCompleted
                    }
                    ApprovalRole::Executive => WorkOrderStatus::TemporaryAction,
                    ApprovalRole::Mechanic => {
                        return Err(KernelError::conflict(
                            "mechanic approval is automatic when the report is submitted",
                        )
                        .into());
                    }
                };
                let context = TransitionGuardContext {
                    actor: TransitionActor::Admin,
                    approval_line_complete: pending.role == ApprovalRole::Executive,
                    completion_evidence_verified: to != WorkOrderStatus::FinalCompleted
                        || row.evidence_verified,
                };
                validate_status_transition(row.status, to, context)?;

                sqlx::query(
                    r#"
                    UPDATE work_order_approval_steps
                    SET status = 'APPROVED',
                        approved_at = $2,
                        approved_by_id = $3,
                        updated_at = $2
                    WHERE id = $1
                    "#,
                )
                .bind(pending.id)
                .bind(occurred_at)
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;

                if pending.role == ApprovalRole::Admin {
                    sqlx::query(
                        r#"
                        UPDATE work_order_approval_steps
                        SET status = 'PENDING',
                            requested_at = $2,
                            updated_at = $2
                        WHERE work_order_id = $1
                          AND role = 'EXECUTIVE'
                          AND status = 'NOT_STARTED'
                        "#,
                    )
                    .bind(row.id)
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                update_status(tx, row, actor, "work_order.approve", to, occurred_at).await
            })
        })
        .await
    }

    pub async fn work_order(
        &self,
        work_order_id: WorkOrderId,
    ) -> Result<WorkOrderSummary, PgWorkOrderError> {
        fetch_work_order_summary_pool(&self.pool, work_order_id).await
    }

    pub async fn target_change_request(
        &self,
        request_id: uuid::Uuid,
    ) -> Result<TargetChangeRequestSummary, PgWorkOrderError> {
        let row = sqlx::query(
            r#"
            SELECT t.id, t.work_order_id, w.branch_id, t.requested_target_due_at, t.status
            FROM target_change_requests t
            JOIN work_orders w ON w.id = t.work_order_id
            WHERE t.id = $1
            "#,
        )
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| KernelError::not_found("target change request was not found"))?;
        let status: String = row.try_get("status")?;
        Ok(TargetChangeRequestSummary {
            id: row.try_get("id")?,
            work_order_id: WorkOrderId::from_uuid(row.try_get("work_order_id")?),
            branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
            requested_target_due_at: row.try_get("requested_target_due_at")?,
            status: TargetChangeStatus::from_db_str(&status)?,
        })
    }

    pub async fn request_target_change(
        &self,
        command: TargetChangeRequestCommand,
    ) -> Result<TargetChangeRequestSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let work_order_id = command.work_order_id;
        let actor = command.actor;
        let requested_target_due_at = command.requested_target_due_at;
        let reason = command.reason;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "target_change.request",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, TargetChangeRequestSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if reason.trim().is_empty() {
                    return Err(KernelError::validation("target change reason is required").into());
                }
                let row = lock_work_order(tx, work_order_id).await?;
                let request_id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                        INSERT INTO target_change_requests (
                            work_order_id, requested_by, requested_target_due_at,
                            reason, status, created_at
                        )
                        VALUES ($1, $2, $3, $4, 'REQUESTED', $5)
                        RETURNING id
                        "#,
                )
                .bind(row.id)
                .bind(*actor.as_uuid())
                .bind(requested_target_due_at)
                .bind(reason.trim())
                .bind(occurred_at)
                .fetch_one(tx.as_mut())
                .await?;

                Ok(TargetChangeRequestSummary {
                    id: request_id,
                    work_order_id,
                    branch_id,
                    requested_target_due_at,
                    status: TargetChangeStatus::Requested,
                })
            })
        })
        .await
    }

    pub async fn review_target_change(
        &self,
        command: ReviewTargetChangeCommand,
    ) -> Result<TargetChangeRequestSummary, PgWorkOrderError> {
        let target = self.target_change_target(command.request_id).await?;
        let actor = command.actor;
        let request_id = command.request_id;
        let decision = command.decision;
        let memo = command.memo;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "target_change.review",
            actor,
            target.branch_id,
            target.work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, TargetChangeRequestSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                        SELECT t.work_order_id, t.requested_target_due_at, t.status, w.branch_id
                        FROM target_change_requests t
                        JOIN work_orders w ON w.id = t.work_order_id
                        WHERE t.id = $1
                        FOR UPDATE OF t
                        "#,
                )
                .bind(request_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("target change request was not found"))?;
                let status: String = row.try_get("status")?;
                if TargetChangeStatus::from_db_str(&status)? != TargetChangeStatus::Requested {
                    return Err(KernelError::conflict(
                        "target change request has already been reviewed",
                    )
                    .into());
                }

                let request_work_order_uuid: uuid::Uuid = row.try_get("work_order_id")?;
                let requested_target_due_at = row.try_get("requested_target_due_at")?;
                let branch_uuid: uuid::Uuid = row.try_get("branch_id")?;
                let status = TargetChangeStatus::from(decision);
                sqlx::query(
                    r#"
                        UPDATE target_change_requests
                        SET status = $2,
                            reviewed_by = $3,
                            reviewed_at = $4,
                            review_memo = $5
                        WHERE id = $1
                        "#,
                )
                .bind(request_id)
                .bind(status.as_db_str())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .bind(memo.as_deref().map(str::trim))
                .execute(tx.as_mut())
                .await?;

                if decision == TargetChangeDecision::Approved {
                    sqlx::query(
                        r#"
                            UPDATE work_orders
                            SET target_due_at = $2, updated_at = $3
                            WHERE id = $1
                            "#,
                    )
                    .bind(request_work_order_uuid)
                    .bind(requested_target_due_at)
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                Ok(TargetChangeRequestSummary {
                    id: request_id,
                    work_order_id: WorkOrderId::from_uuid(request_work_order_uuid),
                    branch_id: BranchId::from_uuid(branch_uuid),
                    requested_target_due_at,
                    status,
                })
            })
        })
        .await
    }

    pub async fn create_daily_plan(
        &self,
        command: CreateDailyPlanCommand,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        let plan_id = DailyPlanId::new();
        let branch_id = command.branch_id;
        let actor = command.actor;
        let mechanic_id = command.mechanic_id;
        let plan_date = command.plan_date;
        let items = command.items;
        let occurred_at = command.occurred_at;
        let event = daily_plan_audit_event(
            "daily_plan.create",
            actor,
            branch_id,
            plan_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, DailyPlanSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if items.is_empty() {
                    return Err(KernelError::validation(
                        "daily plan must include at least one item",
                    )
                    .into());
                }
                sqlx::query(
                    r#"
                    INSERT INTO daily_work_plans (
                        id, branch_id, mechanic_id, plan_date, status, created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, 'DRAFT', $5, $5)
                    "#,
                )
                .bind(*plan_id.as_uuid())
                .bind(*branch_id.as_uuid())
                .bind(*mechanic_id.as_uuid())
                .bind(plan_date)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                for (index, item) in items.into_iter().enumerate() {
                    let sort_order = i32::try_from(index + 1)
                        .map_err(|_| KernelError::validation("daily plan item index overflow"))?;
                    if item.description.trim().is_empty() {
                        return Err(KernelError::validation(
                            "daily plan item description is required",
                        )
                        .into());
                    }
                    sqlx::query(
                        r#"
                        INSERT INTO daily_work_plan_items (
                            plan_id, work_order_id, description, sort_order
                        )
                        VALUES ($1, $2, $3, $4)
                        "#,
                    )
                    .bind(*plan_id.as_uuid())
                    .bind(item.work_order_id.map(|id| *id.as_uuid()))
                    .bind(item.description.trim())
                    .bind(sort_order)
                    .execute(tx.as_mut())
                    .await?;
                }

                Ok(DailyPlanSummary {
                    id: plan_id,
                    branch_id,
                    mechanic_id,
                    plan_date,
                    status: DailyPlanStatus::Draft,
                })
            })
        })
        .await
    }

    pub async fn request_daily_plan_review(
        &self,
        command: SendDailyPlanForReviewCommand,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        self.transition_daily_plan(DailyPlanTransition {
            actor: command.actor,
            plan_id: command.plan_id,
            action: "daily_plan.request",
            trace: command.trace,
            occurred_at: command.occurred_at,
            expected: DailyPlanStatus::Draft,
            next: DailyPlanStatus::Requested,
            memo: None,
        })
        .await
    }

    pub async fn review_daily_plan(
        &self,
        command: ReviewDailyPlanCommand,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        if !matches!(
            command.decision,
            DailyPlanStatus::Approved | DailyPlanStatus::Rejected
        ) {
            return Err(KernelError::validation(
                "daily plan review decision must be APPROVED or REJECTED",
            )
            .into());
        }
        self.transition_daily_plan(DailyPlanTransition {
            actor: command.actor,
            plan_id: command.plan_id,
            action: "daily_plan.review",
            trace: command.trace,
            occurred_at: command.occurred_at,
            expected: DailyPlanStatus::Requested,
            next: command.decision,
            memo: command.memo,
        })
        .await
    }

    pub async fn confirm_daily_plan(
        &self,
        command: SendDailyPlanForReviewCommand,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        self.transition_daily_plan(DailyPlanTransition {
            actor: command.actor,
            plan_id: command.plan_id,
            action: "daily_plan.confirm",
            trace: command.trace,
            occurred_at: command.occurred_at,
            expected: DailyPlanStatus::Approved,
            next: DailyPlanStatus::FinalConfirmed,
            memo: None,
        })
        .await
    }

    pub async fn create_outsource_work(
        &self,
        command: CreateOutsourceWorkCommand,
    ) -> Result<OutsourceWorkSummary, PgWorkOrderError> {
        let branch_id = self.branch_for_work_order(command.work_order_id).await?;
        let actor = command.actor;
        let work_order_id = command.work_order_id;
        let vendor_name = command.vendor_name;
        let vendor_contact = command.vendor_contact;
        let reason = command.reason;
        let occurred_at = command.occurred_at;
        let event = work_order_audit_event(
            "work_order.outsource",
            actor,
            branch_id,
            work_order_id,
            command.trace,
            occurred_at,
        )?;

        with_audit::<_, OutsourceWorkSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if vendor_name.trim().is_empty() || reason.trim().is_empty() {
                    return Err(KernelError::validation(
                        "vendor name and outsource reason are required",
                    )
                    .into());
                }
                let row = lock_work_order(tx, work_order_id).await?;
                let vendor_row = sqlx::query(
                    r#"
                    INSERT INTO outsource_vendors (branch_id, name, contact)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (branch_id, name) DO UPDATE
                    SET contact = COALESCE(EXCLUDED.contact, outsource_vendors.contact),
                        updated_at = now()
                    RETURNING id, name
                    "#,
                )
                .bind(*branch_id.as_uuid())
                .bind(vendor_name.trim())
                .bind(vendor_contact.as_deref().map(str::trim))
                .fetch_one(tx.as_mut())
                .await?;
                let vendor_uuid: uuid::Uuid = vendor_row.try_get("id")?;
                let stored_vendor_name: String = vendor_row.try_get("name")?;
                let outsource_id: uuid::Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO outsource_works (
                        work_order_id, vendor_id, status, reason, requested_at
                    )
                    VALUES ($1, $2, 'REQUESTED', $3, $4)
                    RETURNING id
                    "#,
                )
                .bind(row.id)
                .bind(vendor_uuid)
                .bind(reason.trim())
                .bind(occurred_at)
                .fetch_one(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    UPDATE work_orders
                    SET priority = $2, updated_at = $3
                    WHERE id = $1
                    "#,
                )
                .bind(row.id)
                .bind(PriorityLevel::Outsource.as_db_str())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                Ok(OutsourceWorkSummary {
                    id: outsource_id,
                    work_order_id,
                    vendor_id: VendorId::from_uuid(vendor_uuid),
                    vendor_name: stored_vendor_name,
                    status: OutsourceWorkStatus::Requested,
                })
            })
        })
        .await
    }

    pub async fn daily_plan(
        &self,
        plan_id: DailyPlanId,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        self.daily_plan_target(plan_id).await
    }

    async fn branch_for_work_order(
        &self,
        work_order_id: WorkOrderId,
    ) -> Result<BranchId, PgWorkOrderError> {
        let branch_uuid: uuid::Uuid =
            sqlx::query_scalar("SELECT branch_id FROM work_orders WHERE id = $1")
                .bind(*work_order_id.as_uuid())
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| KernelError::not_found("work order was not found"))?;
        Ok(BranchId::from_uuid(branch_uuid))
    }

    async fn target_change_target(
        &self,
        request_id: uuid::Uuid,
    ) -> Result<TargetChangeTarget, PgWorkOrderError> {
        let row = sqlx::query(
            r#"
            SELECT t.work_order_id, w.branch_id
            FROM target_change_requests t
            JOIN work_orders w ON w.id = t.work_order_id
            WHERE t.id = $1
            "#,
        )
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| KernelError::not_found("target change request was not found"))?;
        Ok(TargetChangeTarget {
            work_order_id: WorkOrderId::from_uuid(row.try_get("work_order_id")?),
            branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        })
    }

    async fn transition_daily_plan(
        &self,
        transition: DailyPlanTransition,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        let DailyPlanTransition {
            actor,
            plan_id,
            action,
            trace,
            occurred_at,
            expected,
            next,
            memo,
        } = transition;
        let plan = self.daily_plan_target(plan_id).await?;
        let event =
            daily_plan_audit_event(action, actor, plan.branch_id, plan_id, trace, occurred_at)?;

        with_audit::<_, DailyPlanSummary, PgWorkOrderError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let current = lock_daily_plan(tx, plan_id).await?;
                if current.status != expected {
                    return Err(KernelError::conflict(format!(
                        "daily plan must be {} before {}",
                        expected.as_db_str(),
                        action
                    ))
                    .into());
                }

                match action {
                    "daily_plan.request" => {
                        sqlx::query(
                            r#"
                            UPDATE daily_work_plans
                            SET status = $2, requested_at = $3, updated_at = $3
                            WHERE id = $1
                            "#,
                        )
                        .bind(*plan_id.as_uuid())
                        .bind(next.as_db_str())
                        .bind(occurred_at)
                        .execute(tx.as_mut())
                        .await?;
                    }
                    "daily_plan.review" => {
                        sqlx::query(
                            r#"
                            UPDATE daily_work_plans
                            SET status = $2,
                                reviewed_by = $3,
                                reviewed_at = $4,
                                review_memo = $5,
                                updated_at = $4
                            WHERE id = $1
                            "#,
                        )
                        .bind(*plan_id.as_uuid())
                        .bind(next.as_db_str())
                        .bind(*actor.as_uuid())
                        .bind(occurred_at)
                        .bind(memo.as_deref().map(str::trim))
                        .execute(tx.as_mut())
                        .await?;
                    }
                    "daily_plan.confirm" => {
                        sqlx::query(
                            r#"
                            UPDATE daily_work_plans
                            SET status = $2, confirmed_at = $3, updated_at = $3
                            WHERE id = $1
                            "#,
                        )
                        .bind(*plan_id.as_uuid())
                        .bind(next.as_db_str())
                        .bind(occurred_at)
                        .execute(tx.as_mut())
                        .await?;
                    }
                    _ => {
                        return Err(KernelError::validation("unknown daily plan action").into());
                    }
                }

                Ok(DailyPlanSummary {
                    status: next,
                    ..current
                })
            })
        })
        .await
    }

    async fn daily_plan_target(
        &self,
        plan_id: DailyPlanId,
    ) -> Result<DailyPlanSummary, PgWorkOrderError> {
        let row = sqlx::query(
            r#"
            SELECT id, branch_id, mechanic_id, plan_date, status
            FROM daily_work_plans
            WHERE id = $1
            "#,
        )
        .bind(*plan_id.as_uuid())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| KernelError::not_found("daily plan was not found"))?;
        daily_plan_summary_from_row(&row)
    }
}

#[derive(Debug, Clone, Copy)]
struct EquipmentLookup {
    equipment_id: uuid::Uuid,
    customer_id: uuid::Uuid,
    site_id: uuid::Uuid,
}

#[derive(Debug, Clone)]
struct WorkOrderRow {
    id: uuid::Uuid,
    request_no: String,
    branch_id: BranchId,
    equipment_id: EquipmentId,
    customer_id: CustomerId,
    site_id: SiteId,
    status: WorkOrderStatus,
    priority: PriorityLevel,
    result_type: WorkResultType,
    evidence_verified: bool,
}

#[derive(Debug, Clone, Copy)]
struct PendingApprovalStep {
    id: uuid::Uuid,
    role: ApprovalRole,
    approver_id: Option<UserId>,
}

#[derive(Debug, Clone, Copy)]
struct TargetChangeTarget {
    work_order_id: WorkOrderId,
    branch_id: BranchId,
}

#[derive(Debug, Clone)]
struct DailyPlanTransition {
    actor: UserId,
    plan_id: DailyPlanId,
    action: &'static str,
    trace: mnt_kernel_core::TraceContext,
    occurred_at: mnt_kernel_core::Timestamp,
    expected: DailyPlanStatus,
    next: DailyPlanStatus,
    memo: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssignmentRequirement {
    Optional,
    Required,
}

fn normalize_management_no(value: &str) -> Result<String, KernelError> {
    let normalized = value.trim().trim_start_matches('#').trim();
    if normalized.is_empty() {
        return Err(KernelError::validation("management number is required"));
    }
    Ok(normalized.to_owned())
}

async fn lookup_equipment_for_management_no(
    tx: &mut Transaction<'_, Postgres>,
    branch_uuid: uuid::Uuid,
    management_no: &str,
) -> Result<EquipmentLookup, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, customer_id, site_id
        FROM registry_equipment
        WHERE branch_id = $1 AND management_no = $2
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(branch_uuid)
    .bind(management_no)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("equipment management number was not found"))?;

    Ok(EquipmentLookup {
        equipment_id: row.try_get("id")?,
        customer_id: row.try_get("customer_id")?,
        site_id: row.try_get("site_id")?,
    })
}

async fn next_request_no(
    tx: &mut Transaction<'_, Postgres>,
    date: Date,
) -> Result<String, PgWorkOrderError> {
    let sequence: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO work_order_request_counters (request_date, last_sequence)
        VALUES ($1, 1)
        ON CONFLICT (request_date) DO UPDATE
        SET last_sequence = work_order_request_counters.last_sequence + 1
        RETURNING last_sequence
        "#,
    )
    .bind(date)
    .fetch_one(tx.as_mut())
    .await?;
    if sequence > 999 {
        return Err(
            KernelError::conflict("daily work-order request number sequence exceeded 999").into(),
        );
    }

    Ok(format!(
        "{:04}{:02}{:02}-{sequence:03}",
        date.year(),
        u8::from(date.month()),
        date.day()
    ))
}

async fn lock_work_order(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
) -> Result<WorkOrderRow, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, request_no, branch_id, equipment_id, customer_id, site_id,
               status, priority, result_type,
               EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status = 'VERIFIED'
               ) AND NOT EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status <> 'VERIFIED'
               ) AS evidence_verified
        FROM work_orders
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("work order was not found"))?;

    work_order_row_from_row(&row)
}

async fn fetch_work_order_summary_tx(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
) -> Result<WorkOrderSummary, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, request_no, branch_id, equipment_id, customer_id, site_id,
               status, priority, result_type,
               EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status = 'VERIFIED'
               ) AND NOT EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status <> 'VERIFIED'
               ) AS evidence_verified
        FROM work_orders
        WHERE id = $1
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    work_order_summary_from_row(&row)
}

async fn fetch_work_order_summary_pool(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<WorkOrderSummary, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, request_no, branch_id, equipment_id, customer_id, site_id,
               status, priority, result_type,
               EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status = 'VERIFIED'
               ) AND NOT EXISTS (
                   SELECT 1
                   FROM evidence_media e
                   WHERE e.work_order_id = work_orders.id
                     AND e.stage IN ('AFTER', 'REPORT')
                     AND e.worm_replica_status <> 'VERIFIED'
               ) AS evidence_verified
        FROM work_orders
        WHERE id = $1
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    work_order_summary_from_row(&row)
}

fn work_order_row_from_row(row: &sqlx::postgres::PgRow) -> Result<WorkOrderRow, PgWorkOrderError> {
    let status: String = row.try_get("status")?;
    let priority: String = row.try_get("priority")?;
    let result_type: String = row.try_get("result_type")?;
    Ok(WorkOrderRow {
        id: row.try_get("id")?,
        request_no: row.try_get("request_no")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        customer_id: CustomerId::from_uuid(row.try_get("customer_id")?),
        site_id: SiteId::from_uuid(row.try_get("site_id")?),
        status: WorkOrderStatus::from_db_str(&status)?,
        priority: PriorityLevel::from_db_str(&priority)?,
        result_type: WorkResultType::from_db_str(&result_type)?,
        evidence_verified: row.try_get("evidence_verified")?,
    })
}

fn work_order_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<WorkOrderSummary, PgWorkOrderError> {
    let row = work_order_row_from_row(row)?;
    Ok(WorkOrderSummary {
        id: WorkOrderId::from_uuid(row.id),
        request_no: row.request_no,
        branch_id: row.branch_id,
        equipment_id: row.equipment_id,
        customer_id: row.customer_id,
        site_id: row.site_id,
        status: row.status,
        priority: row.priority,
        result_type: row.result_type,
        evidence_verified: row.evidence_verified,
    })
}

async fn insert_status_history(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
    actor: Option<UserId>,
    action: &str,
    from_status: Option<WorkOrderStatus>,
    to_status: WorkOrderStatus,
    occurred_at: mnt_kernel_core::Timestamp,
) -> Result<(), PgWorkOrderError> {
    sqlx::query(
        r#"
        INSERT INTO work_order_status_history (
            work_order_id, actor, action, from_status, to_status, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(actor.map(|user| *user.as_uuid()))
    .bind(action)
    .bind(from_status.map(WorkOrderStatus::as_db_str))
    .bind(to_status.as_db_str())
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn update_status(
    tx: &mut Transaction<'_, Postgres>,
    row: WorkOrderRow,
    actor: UserId,
    action: &str,
    to_status: WorkOrderStatus,
    occurred_at: mnt_kernel_core::Timestamp,
) -> Result<WorkOrderSummary, PgWorkOrderError> {
    sqlx::query(
        r#"
        UPDATE work_orders
        SET status = $2, updated_at = $3
        WHERE id = $1
        "#,
    )
    .bind(row.id)
    .bind(to_status.as_db_str())
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    insert_status_history(
        tx,
        WorkOrderId::from_uuid(row.id),
        Some(actor),
        action,
        Some(row.status),
        to_status,
        occurred_at,
    )
    .await?;
    fetch_work_order_summary_tx(tx, WorkOrderId::from_uuid(row.id)).await
}

async fn insert_approval_step(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
    step_order: i16,
    role: ApprovalRole,
    approver_id: Option<UserId>,
    status: &str,
    requested_at: Option<mnt_kernel_core::Timestamp>,
) -> Result<(), PgWorkOrderError> {
    sqlx::query(
        r#"
        INSERT INTO work_order_approval_steps (
            work_order_id, step_order, role, approver_id, status, requested_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(step_order)
    .bind(role.as_db_str())
    .bind(approver_id.map(|user| *user.as_uuid()))
    .bind(status)
    .bind(requested_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn ensure_actor_assignment(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
    actor: UserId,
    requirement: AssignmentRequirement,
) -> Result<(), PgWorkOrderError> {
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM work_order_assignments WHERE work_order_id = $1")
            .bind(*work_order_id.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
    let assigned: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM work_order_assignments
        WHERE work_order_id = $1 AND mechanic_id = $2
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*actor.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;

    if assigned == 1 || (requirement == AssignmentRequirement::Optional && total == 0) {
        return Ok(());
    }

    Err(KernelError::forbidden("actor is not assigned to this work order").into())
}

async fn pending_non_mechanic_approval_step(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
) -> Result<PendingApprovalStep, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, role, approver_id
        FROM work_order_approval_steps
        WHERE work_order_id = $1
          AND role IN ('ADMIN', 'EXECUTIVE')
          AND status = 'PENDING'
        ORDER BY step_order
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::conflict("no pending non-mechanic approval step"))?;

    let role: String = row.try_get("role")?;
    let role = match role.as_str() {
        "ADMIN" => ApprovalRole::Admin,
        "EXECUTIVE" => ApprovalRole::Executive,
        other => {
            return Err(KernelError::validation(format!("unknown approval role {other:?}")).into());
        }
    };
    let approver_uuid: Option<uuid::Uuid> = row.try_get("approver_id")?;
    Ok(PendingApprovalStep {
        id: row.try_get("id")?,
        role,
        approver_id: approver_uuid.map(UserId::from_uuid),
    })
}

async fn lock_daily_plan(
    tx: &mut Transaction<'_, Postgres>,
    plan_id: DailyPlanId,
) -> Result<DailyPlanSummary, PgWorkOrderError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, mechanic_id, plan_date, status
        FROM daily_work_plans
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*plan_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("daily plan was not found"))?;
    daily_plan_summary_from_row(&row)
}

fn daily_plan_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<DailyPlanSummary, PgWorkOrderError> {
    let status: String = row.try_get("status")?;
    Ok(DailyPlanSummary {
        id: DailyPlanId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        mechanic_id: UserId::from_uuid(row.try_get("mechanic_id")?),
        plan_date: row.try_get("plan_date")?,
        status: DailyPlanStatus::from_db_str(&status)?,
    })
}
