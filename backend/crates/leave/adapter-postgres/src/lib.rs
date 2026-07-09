//! Postgres leave-request adapter.
//!
//! Tenant scoping is armed by [`with_audit`]/[`with_org_conn`] from the
//! request-context `app.current_org` GUC; RLS narrows every statement to the
//! caller's org. On top of RLS, the approval queue and decide path are
//! *branch*-scoped in code from the caller's resolved [`BranchScope`], so an
//! approver only ever sees and decides requests in their own branches
//! (deny-by-omission on an empty scope).
//!
//! Two invariants this adapter enforces that the schema cannot:
//!   * **SoD** — the decider must not be the request's requester (mirrors the
//!     workflow-engine initiator guard, #205). Backed by a DB CHECK too, so a
//!     bug cannot stamp a self-decision.
//!   * **approve writes the ledger** — an `approve` decision moves the subject
//!     employee's leave balance (`leave_used += days`, `leave_remaining -= days`)
//!     in the SAME audited transaction as the status change, so the two never
//!     diverge.
//!
//! The §61 statutory push delivers a receipt-gated notice into the target's
//! 개인 수신함 through the inbox crate's [`InboxDocSink`] (the concrete legal
//! delivery) and records the push row. Starting the engine AP- run is gated on
//! the 연차촉진 submittable definition (gap #1); until it exists the push is
//! recorded with `ap_run_id = NULL` and an honest `pending_engine_definition`
//! status — never a fabricated run.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::sync::Arc;

use mnt_inbox_application::{EmitInboxDocCommand, InboxDocSink};
use mnt_inbox_domain::{InboxDocKind, NewInboxDoc};
use mnt_kernel_core::{
    BranchScope, Date, ErrorKind, KernelError, LeavePromotionId, LeaveRequestId, OrgId, UserId,
};
use mnt_leave_application::{
    CreateLeaveRequestCommand, DecideLeaveRequestCommand, LeaveBalancePage, LeaveBalanceView,
    LeaveRequestPage, LeaveRequestView, ListLeaveRequestsQuery, StatutoryPushCommand,
    StatutoryPushView, leave_promotion_audit_event, leave_request_audit_event,
};
use mnt_leave_domain::{LeaveStatus, LeaveType, PromotionKind, validate_round};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

const REQUEST_COLUMNS: &str = "id, branch_id, requester_user_id, subject_employee_id, leave_type, \
     days::float8 AS days, start_date, end_date, reason, status, decided_by, decided_at, \
     decision_comment, ap_run_id, created_at";

#[derive(Debug, thiserror::Error)]
pub enum PgLeaveError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgLeaveError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgLeaveError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgLeaveError> for KernelError {
    fn from(value: PgLeaveError) -> Self {
        match value {
            PgLeaveError::Domain(err) => err,
            PgLeaveError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}

#[derive(Clone)]
pub struct PgLeaveStore {
    pool: PgPool,
    inbox: Arc<dyn InboxDocSink>,
}

impl std::fmt::Debug for PgLeaveStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgLeaveStore").finish_non_exhaustive()
    }
}

impl PgLeaveStore {
    #[must_use]
    pub fn new(pool: PgPool, inbox: Arc<dyn InboxDocSink>) -> Self {
        Self { pool, inbox }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // -----------------------------------------------------------------------
    // Create (crate-level write port — see application docs)
    // -----------------------------------------------------------------------

    /// Insert a pending leave request. Domain validation happens in the caller
    /// (`NewLeaveRequest`); the row is created `pending`, unassigned.
    pub async fn create_request(
        &self,
        command: CreateLeaveRequestCommand,
    ) -> Result<LeaveRequestView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let id = LeaveRequestId::new();
        let requester = *command.requester_user_id.as_uuid();
        let event = leave_request_audit_event(
            "leave_request.create",
            Some(command.requester_user_id),
            id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "status": "pending",
                "leave_type": command.leave_type.as_str(),
                "days": command.days,
                "subject_employee_id": command.subject_employee_id,
            })),
        );

        let leave_type = command.leave_type.as_str();
        let row =
            with_audit::<_, sqlx::postgres::PgRow, PgLeaveError>(&self.pool, event, move |tx| {
                Box::pin(async move {
                    Ok(sqlx::query(
                        "INSERT INTO leave_requests \
                     (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, \
                      days, start_date, end_date, reason, status) \
                     VALUES ($1, NULLIF(current_setting('app.current_org', true), '')::uuid, \
                             $2, $3, $4, $5, $6, $7, $8, $9, 'pending') \
                     RETURNING id, branch_id, requester_user_id, subject_employee_id, leave_type, \
                       days::float8 AS days, start_date, end_date, reason, status, decided_by, \
                       decided_at, decision_comment, ap_run_id, created_at",
                    )
                    .bind(id.as_uuid())
                    .bind(command.branch_id)
                    .bind(requester)
                    .bind(command.subject_employee_id)
                    .bind(leave_type)
                    .bind(command.days)
                    .bind(command.start_date)
                    .bind(command.end_date)
                    .bind(command.reason)
                    .fetch_one(tx.as_mut())
                    .await?)
                })
            })
            .await?;
        request_from_row(&row)
    }

    // -----------------------------------------------------------------------
    // Queue read (branch-scoped)
    // -----------------------------------------------------------------------

    pub async fn list_requests(
        &self,
        query: ListLeaveRequestsQuery,
    ) -> Result<LeaveRequestPage, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let limit = query.limit.clamp(1, 200);
        let rows = with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut builder = QueryBuilder::<Postgres>::new(format!(
                    "SELECT {REQUEST_COLUMNS} FROM leave_requests WHERE "
                ));
                push_branch_scope(&mut builder, &query.branch_scope);
                if let Some(status) = query.status {
                    builder.push(" AND status = ");
                    builder.push_bind(status.as_str());
                }
                // Pending first (the actionable queue), then newest.
                builder
                    .push(" ORDER BY (status = 'pending') DESC, created_at DESC, id DESC LIMIT ");
                builder.push_bind(limit);
                Ok(builder.build().fetch_all(tx.as_mut()).await?)
            })
        })
        .await?;
        let items = rows
            .iter()
            .map(request_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(LeaveRequestPage { items })
    }

    // -----------------------------------------------------------------------
    // Decide (SoD + ledger write-back)
    // -----------------------------------------------------------------------

    pub async fn decide(
        &self,
        command: DecideLeaveRequestCommand,
    ) -> Result<LeaveRequestView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let request_id = command.request_id;
        let decider = command.decider;

        // Read-first to classify before mutating: NotFound (or out-of-branch),
        // already-decided (409), or self-decision (SoD, 403). A branch-scoped
        // read means an out-of-scope request is indistinguishable from a
        // missing one — deny-by-omission.
        let existing = self
            .fetch_request_scoped(org, request_id, &command.branch_scope)
            .await?
            .ok_or_else(|| KernelError::not_found("leave request not found"))?;
        if existing.status != LeaveStatus::Pending {
            return Err(KernelError::conflict(format!(
                "leave request is already {} and cannot be decided again",
                existing.status.as_str()
            ))
            .into());
        }
        if existing.requester_user_id == decider {
            return Err(KernelError::forbidden(
                "a leave request cannot be decided by its own requester (separation of duties)",
            )
            .into());
        }

        let decision = command.decision;
        let new_status = decision.resulting_status();
        let comment = command.comment.clone();
        let occurred_at = command.occurred_at;
        let decider_uuid = *decider.as_uuid();
        let subject_employee_id = existing.subject_employee_id;
        let days = existing.days;

        let event = leave_request_audit_event(
            "leave_request.decide",
            Some(decider),
            request_id,
            command.trace,
            command.occurred_at,
        )?
        .with_branch(mnt_kernel_core::BranchId::from_uuid(existing.branch_id))
        .with_org(org)
        .with_snapshots(
            Some(serde_json::json!({ "status": existing.status.as_str() })),
            Some(serde_json::json!({
                "status": new_status.as_str(),
                "decision": decision.as_str(),
                "decided_by": decider_uuid,
                "ledger_effect": decision.writes_ledger(),
            })),
        );

        let request_id_uuid = *request_id.as_uuid();
        let row =
            with_audit::<_, sqlx::postgres::PgRow, PgLeaveError>(&self.pool, event, move |tx| {
                Box::pin(async move {
                    let row = sqlx::query(
                        "UPDATE leave_requests \
                     SET status = $2, decided_by = $3, decided_at = $4, decision_comment = $5 \
                     WHERE id = $1 AND status = 'pending' \
                     RETURNING id, branch_id, requester_user_id, subject_employee_id, leave_type, \
                       days::float8 AS days, start_date, end_date, reason, status, decided_by, \
                       decided_at, decision_comment, ap_run_id, created_at",
                    )
                    .bind(request_id_uuid)
                    .bind(new_status.as_str())
                    .bind(decider_uuid)
                    .bind(occurred_at)
                    .bind(comment)
                    .fetch_optional(tx.as_mut())
                    .await?
                    // A concurrent decide won the race between our read and update.
                    .ok_or_else(|| {
                        PgLeaveError::Domain(KernelError::conflict(
                            "leave request was decided concurrently",
                        ))
                    })?;

                    // Ledger write-back: an approval moves the subject employee's
                    // balance in this same transaction. COALESCE because imported
                    // rows may have NULL leave figures.
                    if decision.writes_ledger() {
                        let affected = sqlx::query(
                            "UPDATE employees \
                         SET leave_used = COALESCE(leave_used, 0) + $2, \
                             leave_remaining = COALESCE(leave_remaining, 0) - $2, \
                             updated_at = now() \
                         WHERE id = $1",
                        )
                        .bind(subject_employee_id)
                        .bind(days)
                        .execute(tx.as_mut())
                        .await?
                        .rows_affected();
                        if affected != 1 {
                            return Err(PgLeaveError::Domain(KernelError::not_found(
                                "subject employee not found for leave-ledger write-back",
                            )));
                        }
                    }
                    Ok(row)
                })
            })
            .await?;
        request_from_row(&row)
    }

    async fn fetch_request_scoped(
        &self,
        org: OrgId,
        id: LeaveRequestId,
        branch_scope: &BranchScope,
    ) -> Result<Option<LeaveRequestView>, PgLeaveError> {
        let id_uuid = *id.as_uuid();
        let branch_scope = branch_scope.clone();
        let row = with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut builder = QueryBuilder::<Postgres>::new(format!(
                    "SELECT {REQUEST_COLUMNS} FROM leave_requests WHERE id = "
                ));
                builder.push_bind(id_uuid);
                builder.push(" AND ");
                push_branch_scope(&mut builder, &branch_scope);
                Ok(builder.build().fetch_optional(tx.as_mut()).await?)
            })
        })
        .await?;
        row.as_ref().map(request_from_row).transpose()
    }

    // -----------------------------------------------------------------------
    // Balances roster (reads the existing employees leave ledger; no duplicate)
    // -----------------------------------------------------------------------

    pub async fn list_balances(&self) -> Result<LeaveBalancePage, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, name, org_unit, \
                            COALESCE(leave_accrued, 0)::float8  AS grant_days, \
                            COALESCE(leave_used, 0)::float8     AS used_days, \
                            COALESCE(leave_remaining, 0)::float8 AS left_days \
                     FROM employees \
                     WHERE leave_accrued IS NOT NULL \
                        OR leave_used IS NOT NULL \
                        OR leave_remaining IS NOT NULL \
                     ORDER BY name ASC, id ASC",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        let items = rows
            .iter()
            .map(balance_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(LeaveBalancePage { items })
    }

    // -----------------------------------------------------------------------
    // §61 statutory push
    // -----------------------------------------------------------------------

    /// Serve a §61 promotion (1차/2차) or a 노무수령거부 notice: deliver the
    /// receipt-gated document into the target's 개인 수신함 and record the push.
    /// Idempotent per `(org, target, kind, round)`.
    pub async fn statutory_push(
        &self,
        command: StatutoryPushCommand,
    ) -> Result<StatutoryPushView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let round = validate_round(command.kind, command.round).map_err(PgLeaveError::Domain)?;
        let notice_type = command.kind.notice_type();
        let legal_basis = command.kind.legal_basis();

        let (title, body) = notice_body(&command, round);
        let dedup_key = format!(
            "leave-{}-{}-r{round}",
            command.kind.as_str(),
            command.target_employee_id
        );
        let doc = NewInboxDoc::new(
            InboxDocKind::LegalNotice,
            &title,
            Some(notice_type),
            Some(legal_basis),
            Some("leave_promotion"),
            // Deterministic source id ties the notice back to the push row.
            Some(&dedup_key),
            body,
        )
        .map_err(PgLeaveError::Domain)?;

        // 1. Deliver the receipt-gated notice (own audited, idempotent tx).
        let emitted = self
            .inbox
            .emit(EmitInboxDocCommand {
                actor: Some(command.actor),
                recipient: command.target_user_id,
                doc,
                dedup_key: Some(dedup_key),
                trace: command.trace.clone(),
                occurred_at: command.occurred_at,
            })
            .await
            .map_err(PgLeaveError::Domain)?;

        // 2. Record the push, referencing the delivered notice. The engine AP-
        //    run stays NULL until the 연차촉진 submittable definition exists
        //    (gap #1); we never fabricate a run.
        let id = LeavePromotionId::new();
        let inbox_doc_id = *emitted.id.as_uuid();
        let target_user = *command.target_user_id.as_uuid();
        let actor = *command.actor.as_uuid();
        let event = leave_promotion_audit_event(
            "leave_promotion.push",
            Some(command.actor),
            id,
            command.trace,
            command.occurred_at,
        )?
        .with_branch(mnt_kernel_core::BranchId::from_uuid(command.branch_id))
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "kind": command.kind.as_str(),
                "round": round,
                "target_user_id": target_user,
                "inbox_doc_id": inbox_doc_id,
                "legal_basis": legal_basis,
                "ap_submission": "pending_engine_definition",
            })),
        );

        let kind = command.kind.as_str();
        let branch_id = command.branch_id;
        let target_employee_id = command.target_employee_id;
        let existing_id =
            with_audit::<_, Option<uuid::Uuid>, PgLeaveError>(&self.pool, event, move |tx| {
                Box::pin(async move {
                    let inserted = sqlx::query(
                        "INSERT INTO leave_promotions \
                         (id, org_id, branch_id, target_user_id, target_employee_id, kind, round, \
                          inbox_doc_id, created_by) \
                         VALUES ($1, NULLIF(current_setting('app.current_org', true), '')::uuid, \
                                 $2, $3, $4, $5, $6, $7, $8) \
                         ON CONFLICT (org_id, target_employee_id, kind, round) DO NOTHING \
                         RETURNING id",
                    )
                    .bind(id.as_uuid())
                    .bind(branch_id)
                    .bind(target_user)
                    .bind(target_employee_id)
                    .bind(kind)
                    .bind(round)
                    .bind(inbox_doc_id)
                    .bind(actor)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    // Row present => a genuinely new push (audited). Absent =>
                    // a duplicate; signal via the sentinel so with_audit rolls
                    // back the (empty) audit for the no-op.
                    match inserted {
                        Some(_) => Ok(None),
                        None => Err(PgLeaveError::Domain(KernelError::conflict("__dup__"))),
                    }
                })
            })
            .await;

        let push_id = match existing_id {
            Ok(_) => id,
            // Duplicate push: return the already-recorded row idempotently.
            Err(PgLeaveError::Domain(ref e)) if e.message == "__dup__" => {
                self.find_promotion(org, target_employee_id, kind, round)
                    .await?
            }
            Err(other) => return Err(other),
        };

        Ok(StatutoryPushView {
            id: push_id,
            kind: command.kind,
            round,
            target_user_id: command.target_user_id,
            inbox_doc_id,
            ap_run_id: None,
            ap_submission: "pending_engine_definition".to_owned(),
        })
    }

    async fn find_promotion(
        &self,
        org: OrgId,
        target_employee_id: uuid::Uuid,
        kind: &str,
        round: i16,
    ) -> Result<LeavePromotionId, PgLeaveError> {
        let kind = kind.to_owned();
        let row = with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id FROM leave_promotions \
                     WHERE target_employee_id = $1 AND kind = $2 AND round = $3",
                )
                .bind(target_employee_id)
                .bind(kind)
                .bind(round)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        let row = row
            .ok_or_else(|| KernelError::internal("duplicate push but no existing promotion row"))?;
        Ok(LeavePromotionId::from_uuid(row.try_get("id")?))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Narrow a query to the caller's branch scope. `BranchScope::All` sees every
/// branch-scoped row; an empty `Branches` set matches nothing (deny-by-omission).
fn push_branch_scope(builder: &mut QueryBuilder<Postgres>, scope: &BranchScope) {
    match scope {
        BranchScope::All => {
            builder.push("TRUE");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let ids = branches.iter().map(|b| *b.as_uuid()).collect::<Vec<_>>();
            builder.push("branch_id = ANY(");
            builder.push_bind(ids);
            builder.push(")");
        }
    }
}

fn request_from_row(row: &sqlx::postgres::PgRow) -> Result<LeaveRequestView, PgLeaveError> {
    let decided_by: Option<uuid::Uuid> = row.try_get("decided_by")?;
    let ap_run_id: Option<uuid::Uuid> = row.try_get("ap_run_id")?;
    Ok(LeaveRequestView {
        id: LeaveRequestId::from_uuid(row.try_get("id")?),
        branch_id: row.try_get("branch_id")?,
        requester_user_id: UserId::from_uuid(row.try_get("requester_user_id")?),
        subject_employee_id: row.try_get("subject_employee_id")?,
        leave_type: LeaveType::parse(row.try_get::<String, _>("leave_type")?.as_str())?,
        days: row.try_get("days")?,
        start_date: row.try_get::<Date, _>("start_date")?,
        end_date: row.try_get::<Date, _>("end_date")?,
        reason: row.try_get("reason")?,
        status: LeaveStatus::parse(row.try_get::<String, _>("status")?.as_str())?,
        decided_by: decided_by.map(UserId::from_uuid),
        decided_at: row.try_get("decided_at")?,
        decision_comment: row.try_get("decision_comment")?,
        ap_run_id,
        created_at: row.try_get("created_at")?,
    })
}

fn balance_from_row(row: &sqlx::postgres::PgRow) -> Result<LeaveBalanceView, PgLeaveError> {
    let grant: f64 = row.try_get("grant_days")?;
    let used: f64 = row.try_get("used_days")?;
    let left: f64 = row.try_get("left_days")?;
    Ok(LeaveBalanceView {
        employee_id: row.try_get("id")?,
        name: row.try_get("name")?,
        team: row.try_get("org_unit")?,
        grant,
        used,
        left,
        tone: balance_tone(grant, used, left),
    })
}

/// Bucket a balance for the bar color + 촉진 flag, mirroring the prototype:
/// mostly-unused (used < 50% of grant) ⇒ `promote` (촉진 대상); nearly-exhausted
/// (≤ 2 days left) ⇒ `low`; otherwise `ok`.
// ponytail: fixed thresholds; move to org policy if HR wants them configurable.
fn balance_tone(grant: f64, used: f64, left: f64) -> String {
    if grant > 0.0 && used / grant < 0.5 {
        "promote".to_owned()
    } else if left <= 2.0 {
        "low".to_owned()
    } else {
        "ok".to_owned()
    }
}

/// Render the statutory notice title + JSONB body delivered into the inbox.
fn notice_body(command: &StatutoryPushCommand, round: i16) -> (String, serde_json::Value) {
    match command.kind {
        PromotionKind::Promotion => (
            format!("연차 사용 촉진 통지 ({round}차)"),
            serde_json::json!({
                "kind": "promotion",
                "round": round,
                "target": command.target_name,
                "unused_days": command.unused_days,
                "legal_basis": "근로기준법 제61조",
                "paragraphs": [
                    format!(
                        "귀하의 미사용 연차 {}일에 대하여 근로기준법 제61조에 따라 사용을 촉구합니다.",
                        command.unused_days
                    ),
                    if round >= 2 {
                        "사용 시기를 지정하여 통보하오니 지정된 시기에 연차를 사용하시기 바랍니다."
                            .to_owned()
                    } else {
                        "미사용 연차의 사용 시기를 정하여 회신하여 주시기 바랍니다.".to_owned()
                    },
                ],
            }),
        ),
        PromotionKind::Refusal => (
            "노무수령거부 통지".to_owned(),
            serde_json::json!({
                "kind": "refusal",
                "round": round,
                "target": command.target_name,
                "unused_days": command.unused_days,
                "legal_basis": "근로기준법 제61조",
                "paragraphs": [
                    "연차 사용 촉진 절차에도 미사용된 연차에 대하여 노무 수령을 거부합니다.",
                    "본 통지로써 해당 연차에 대한 사용자의 금전 보상 의무가 소멸함을 안내드립니다.",
                ],
            }),
        ),
    }
}
